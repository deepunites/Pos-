import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

let testTenantId: string;
let testUserId: string;
let adminToken: string;
let cashierToken: string;

export { prisma, testTenantId, testUserId, adminToken, cashierToken };

// Child rows first: cash shifts, receipts and audit rows reference users and
// products, so deleting users up front used to trip a foreign key and abort
// the whole suite.
async function wipe() {
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.customerDebtEntry.deleteMany();
  await prisma.order.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.cashShift.deleteMany();
  await prisma.stockReceiptItem.deleteMany();
  await prisma.stockReceipt.deleteMany();
  await prisma.inventoryMovement.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.table.deleteMany();
  await prisma.productModifierGroup.deleteMany();
  await prisma.modifierItem.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.product.deleteMany();
  await prisma.techCard.deleteMany();
  await prisma.category.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.catalogProduct.deleteMany();
  await prisma.catalogMeta.deleteMany();
}

export const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:3100";

export async function setupTestData() {
  await wipe();

  // Create test tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: "Test Restaurant",
      slug: "test-restaurant",
      email: "test@test.com",
      currency: "USD",
      taxRate: 10,
    },
  });
  testTenantId = tenant.id;

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 12);
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "admin@test.com",
      passwordHash: adminPassword,
      firstName: "Admin",
      lastName: "Test",
      role: "admin",
    },
  });
  testUserId = admin.id;

  // Create cashier user
  const cashierPassword = await bcrypt.hash("cashier123", 12);
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "cashier@test.com",
      passwordHash: cashierPassword,
      firstName: "Cashier",
      lastName: "Test",
      role: "cashier",
    },
  });

  // Create category
  const category = await prisma.category.create({
    data: {
      tenantId: tenant.id,
      name: "Burgers",
      color: "#ef4444",
    },
  });

  // Create product
  await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: category.id,
      name: "Classic Burger",
      price: 12.99,
      costPrice: 4.50,
      sku: "BRG-001",
      currentStock: 50,
      trackInventory: true,
    },
  });

  // Create table
  await prisma.table.create({
    data: {
      tenantId: tenant.id,
      number: "1",
      capacity: 4,
    },
  });

  return { tenantId: tenant.id };
}

export async function getTokens(baseUrl: string) {
  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "admin123" }),
  });
  const adminData = await adminLogin.json() as any;
  adminToken = adminData.data.accessToken;

  const cashierLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cashier@test.com", password: "cashier123" }),
  });
  const cashierData = await cashierLogin.json() as any;
  cashierToken = cashierData.data.accessToken;

  return { adminToken, cashierToken };
}

export async function cleanupTestData() {
  await wipe();
  await prisma.$disconnect();
}
