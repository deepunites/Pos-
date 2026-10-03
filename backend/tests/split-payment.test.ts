import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Оплата частями на кассе магазина: «Карта + наличные» — чек 60 000, 40 000
// картой, 20 000 наличными. Каждая часть — своя запись оплаты, смена считает
// их по способам.

let cashier: string;
let productId: string;
let shiftId: string;

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cashier}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const sale = (pay: Record<string, unknown>) =>
  api("/orders/checkout", { type: "takeaway", cashShiftId: shiftId, items: [{ productId, quantity: 1 }], expectedTotal: 60000, ...pay });

describe("Split payment: card + cash", () => {
  beforeAll(async () => {
    await setupTestData();
    cashier = (await getTokens(BASE_URL)).cashierToken;
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    productId = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Сок", price: 60000, trackInventory: true, currentStock: 50 } })).id;
    shiftId = (await api("/cash-shifts/open", { openingCash: 100000 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("records each part as its own payment and the shift counts them by method", async () => {
    const res = await sale({ payments: [{ method: "card", amount: 40000 }, { method: "cash", amount: 20000 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const payments = await prisma.payment.findMany({ where: { orderId: res.body.data.id }, orderBy: { amount: "desc" } });
    expect(payments.map((p) => [p.method, p.amount, p.status])).toEqual([
      ["card", 40000, "completed"],
      ["cash", 20000, "completed"],
    ]);

    const shift = (await api("/cash-shifts/current")).body.data;
    expect(shift.totalCardSales).toBe(40000);
    expect(shift.totalCashSales).toBe(20000);
    expect(shift.expectedCash).toBe(100000 + 20000);
  });

  it("refuses parts that do not add up to the check", async () => {
    const res = await sale({ payments: [{ method: "card", amount: 40000 }, { method: "cash", amount: 10000 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/част/i);
  });

  it("wants either one payment or the parts, not both and not neither", async () => {
    expect((await sale({})).status).toBe(400);
    expect((await sale({ payment: { method: "cash" }, payments: [{ method: "cash", amount: 60000 }] })).status).toBe(400);
  });

  it("refuses zero and negative parts", async () => {
    expect((await sale({ payments: [{ method: "card", amount: 60000 }, { method: "cash", amount: 0 }] })).status).toBe(400);
    expect((await sale({ payments: [{ method: "card", amount: 70000 }, { method: "cash", amount: -10000 }] })).status).toBe(400);
  });

  it("still takes the old single payment, as offline queues on the tills send it", async () => {
    const res = await sale({ payment: { method: "cash" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const payments = await prisma.payment.findMany({ where: { orderId: res.body.data.id } });
    expect(payments.map((p) => [p.method, p.amount])).toEqual([["cash", 60000]]);
  });

  it("does not take a card part in a sale made without connection", async () => {
    const res = await api("/orders/checkout", {
      type: "takeaway",
      items: [{ productId, quantity: 1, unitPrice: 60000 }],
      expectedTotal: 60000,
      payments: [{ method: "card", amount: 40000 }, { method: "cash", amount: 20000 }],
      offline: { soldAt: new Date().toISOString() },
    });
    expect(res.status).toBe(400);
  });

  it("prints every part on the receipt", async () => {
    const res = await sale({ payments: [{ method: "card", amount: 40000 }, { method: "cash", amount: 20000 }] });
    const receipt = await fetch(`${BASE_URL}/api/receipts/${res.body.data.id}`, { headers: { Authorization: `Bearer ${cashier}` } });
    const html = await receipt.text();
    expect(html).toMatch(/Карта[\s\S]*40\s000[\s\S]*Наличные[\s\S]*20\s000/);
  });
});
