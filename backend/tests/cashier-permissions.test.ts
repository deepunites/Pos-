import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Права кассира — галочки в карточке сотрудника: продажа в долг, приход
// товара, «слепое» закрытие смены. Запрет держит сервер, а не только касса.

let admin: string;
let cashier: string;
let cashierId: string;
let productId: string;
let customerId: string;
let shiftId: string;

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const setRights = (data: Record<string, boolean>) => call("PUT", `/users/${cashierId}`, admin, data);
const sale = (token: string, payments: unknown[]) =>
  call("POST", "/orders/checkout", token, {
    type: "takeaway",
    cashShiftId: shiftId,
    items: [{ productId, quantity: 1 }],
    expectedTotal: 10000,
    payments,
    customerId,
  });

describe("Cashier permissions", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    cashierId = (await prisma.user.findFirstOrThrow({ where: { tenantId: testTenantId, role: "cashier" } })).id;
    productId = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Сок", price: 10000, trackInventory: true, currentStock: 100 } })).id;
    customerId = (await call("POST", "/customers", cashier, { firstName: "Алишер", phone: "+998901234567" })).body.data.id;
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 50000 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("allow everything until the admin takes a right away", async () => {
    const me = await call("GET", "/auth/me", cashier);
    expect(me.body.data.permissions).toEqual({ canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true, canRefund: true });
    const user = await call("GET", `/users/${cashierId}`, admin);
    expect(user.body.data).toMatchObject({ canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true });
  });

  it("are set by the admin, and the cashier cannot give them back to himself", async () => {
    const res = await setRights({ canSellOnDebt: false, canReceiveStock: false, canSeeExpectedCash: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ canSellOnDebt: false, canReceiveStock: false, canSeeExpectedCash: false });
    expect((await call("PUT", `/users/${cashierId}`, cashier, { canSellOnDebt: true })).status).toBe(403);
    // без перевхода: касса узнаёт о снятой галочке из /auth/me
    expect((await call("GET", "/auth/me", cashier)).body.data.permissions).toEqual({ canSellOnDebt: false, canReceiveStock: false, canSeeExpectedCash: false, canRefund: true });
  });

  it("stop a debt sale, but not a sale for money", async () => {
    const debt = await sale(cashier, [{ method: "debt", amount: 10000 }]);
    expect(debt.status).toBe(403);
    expect(debt.body.error).toMatch(/в долг вам закрыта/);
    expect((await sale(cashier, [{ method: "cash", amount: 4000 }, { method: "debt", amount: 6000 }])).status).toBe(403);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).debtBalance).toBe(0);
    expect((await sale(cashier, [{ method: "cash", amount: 10000 }])).status).toBe(201);
  });

  it("stop a stock receipt, new products included", async () => {
    const res = await call("POST", "/stock-receipts", cashier, { items: [{ productId, quantity: 5, costPrice: 7000 }] });
    expect(res.status).toBe(403);
    const fresh = await call("POST", "/stock-receipts", cashier, { items: [{ newProduct: { name: "Печенье", barcode: "4780011111111" }, quantity: 5, costPrice: 7000, salePrice: 9000 }] });
    expect(fresh.status).toBe(403);
    expect(await prisma.product.count({ where: { tenantId: testTenantId, name: "Печенье" } })).toBe(0);
  });

  it("hide what the drawer should hold — while the shift runs and after it is closed", async () => {
    const current = (await call("GET", "/cash-shifts/current", cashier)).body.data;
    expect(current).toMatchObject({ id: shiftId, openingCash: 50000, blind: true });
    expect(current.expectedCash).toBeUndefined();
    expect(current.totalCashSales).toBeUndefined();
    expect(current.orders).toBeUndefined(); // суммы чеков — та же ожидаемая сумма
    const byId = (await call("GET", `/cash-shifts/${shiftId}`, cashier)).body.data;
    expect(byId.expectedCash).toBeUndefined();
    expect(byId.orders).toBeUndefined();
    expect(typeof byId.ordersCount).toBe("number");

    const closed = await call("POST", `/cash-shifts/${shiftId}/close`, cashier, { closingCash: 59000 });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: "closed", closingCash: 59000, blind: true });
    expect(closed.body.data.difference).toBeUndefined();

    // администратор видит всё: ожидалось 50 000 + 10 000 наличными, недостача 1 000
    const seen = (await call("GET", `/cash-shifts/${shiftId}`, admin)).body.data;
    expect(seen).toMatchObject({ expectedCash: 60000, difference: -1000 });
    expect(seen.blind).toBeUndefined();
  });

  it("give the rights back when the admin ticks them again", async () => {
    await setRights({ canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true });
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 0 })).body.data.id;
    expect((await sale(cashier, [{ method: "debt", amount: 10000 }])).status).toBe(201);
    expect((await call("POST", "/stock-receipts", cashier, { items: [{ productId, quantity: 5, costPrice: 7000 }] })).status).toBe(201);
    expect((await call("GET", "/cash-shifts/current", cashier)).body.data.expectedCash).toBe(0);
  });

  it("never limit the admin or the manager", async () => {
    const res = await call("POST", "/auth/login", admin, { email: "admin@test.com", password: "admin123" });
    expect(res.body.data.user.permissions).toEqual({ canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true, canRefund: true });
  });
});
