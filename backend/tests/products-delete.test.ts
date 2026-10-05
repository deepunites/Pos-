import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// «Удалить» товар: без продаж и приходов — насовсем (заведён по ошибке,
// тестовый), с историей — только снимается с продажи, чеки и отчёты целы.

let admin: string;
let cashier: string;
let shiftId: string;

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const remove = (id: string, token = admin) => call("DELETE", `/products/${id}`, token);
const product = (data: Record<string, unknown>) => prisma.product.create({ data: { tenantId: testTenantId, price: 1000, ...data } as any });
const exists = async (id: string) => prisma.product.findUnique({ where: { id }, select: { isActive: true } });

describe("Deleting a product", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 0 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("removes a never-sold product for good, with the stock typed in by hand", async () => {
    const typo = await product({ name: "Опечатка", trackInventory: true, currentStock: 5 });
    await prisma.inventoryMovement.create({ data: { tenantId: testTenantId, productId: typo.id, type: "in", quantity: 5, reason: "Импорт" } });
    const res = await remove(typo.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ removed: "deleted" });
    expect(await exists(typo.id)).toBeNull();
    expect(await prisma.inventoryMovement.count({ where: { productId: typo.id } })).toBe(0);
  });

  it("removes for good a product already taken off sale — the old test products", async () => {
    const old = await product({ name: "ТЕСТ — удалить", isActive: false, trackInventory: true, currentStock: 3, minStock: 5 });
    expect((await remove(old.id)).body.data).toEqual({ removed: "deleted" });
    expect(await exists(old.id)).toBeNull();
  });

  it("only takes a sold product off sale: the check keeps its line", async () => {
    const water = await product({ name: "Вода", trackInventory: true, currentStock: 10 });
    const sale = await call("POST", "/orders/checkout", cashier, { type: "takeaway", cashShiftId: shiftId, items: [{ productId: water.id, quantity: 1 }], expectedTotal: 1000, payment: { method: "cash" } });
    expect(sale.status).toBe(201);
    expect((await remove(water.id)).body.data).toEqual({ removed: "archived" });
    expect(await exists(water.id)).toEqual({ isActive: false });
    expect(await prisma.orderItem.count({ where: { productId: water.id } })).toBe(1);
  });

  it("only takes a received product off sale", async () => {
    const juice = await product({ name: "Сок", trackInventory: true });
    expect((await call("POST", "/stock-receipts", admin, { items: [{ productId: juice.id, quantity: 6, costPrice: 700 }] })).status).toBe(201);
    expect((await remove(juice.id)).body.data).toEqual({ removed: "archived" });
    expect(await exists(juice.id)).toEqual({ isActive: false });
  });

  it("only takes off an ingredient that a recipe uses", async () => {
    const flour = await product({ name: "Мука", isIngredient: true });
    await prisma.techCard.create({ data: { tenantId: testTenantId, name: "Лепёшка", ingredients: JSON.stringify([{ ingredientId: flour.id, quantity: 200 }]) } as any });
    expect((await remove(flour.id)).body.data).toEqual({ removed: "archived" });
    const salt = await product({ name: "Соль", isIngredient: true });
    expect((await remove(salt.id)).body.data).toEqual({ removed: "deleted" });
  });

  it("is for the admin and the manager, within their own shop", async () => {
    const mine = await product({ name: "Мой товар" });
    expect((await remove(mine.id, cashier)).status).toBe(403);
    const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-delete", email: "d@x.uz" } });
    const theirs = await prisma.product.create({ data: { tenantId: other.id, name: "Чужой", price: 1 } });
    expect((await remove(theirs.id)).status).toBe(404);
    expect(await exists(theirs.id)).toEqual({ isActive: true });
  });
});
