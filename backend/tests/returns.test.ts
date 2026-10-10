import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Возврат товара на кассе: по чеку — выбранные строки и количество, без чека —
// по текущей цене. Деньги — как решил кассир; товар — на склад, брак — нет.

let admin: string;
let cashier: string;
let cashierId: string;
let shiftId: string;
let water: { id: string };
let rice: { id: string };

const call = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const sell = async (items: unknown[], expectedTotal: number, extra: Record<string, unknown> = {}) => {
  const res = await call("POST", "/orders/checkout", cashier, { type: "takeaway", cashShiftId: shiftId, items, expectedTotal, payment: { method: "cash" }, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; orderNumber: number };
};
const linesOf = async (orderId: string) => prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
const giveBack = (body: Record<string, unknown>, token = cashier, headers: Record<string, string> = {}) =>
  call("POST", "/returns", token, { cashShiftId: shiftId, method: "cash", ...body }, headers);
const stock = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).currentStock;
const current = async () => (await call("GET", "/cash-shifts/current", cashier)).body.data;

describe("Returns at the till", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    cashierId = (await prisma.user.findFirstOrThrow({ where: { tenantId: testTenantId, role: "cashier" } })).id;
    water = await prisma.product.create({ data: { tenantId: testTenantId, name: "Вода 1,5 л", barcode: "4780000000991", price: 5000, trackInventory: true, currentStock: 50 } });
    rice = await prisma.product.create({ data: { tenantId: testTenantId, name: "Рис девзира", price: 24000, saleUnit: "кг", unit: "kg", trackInventory: true, currentStock: 20 } });
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 100000 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("finds a sale by its number, by a product in it, and lists recent ones", async () => {
    const sale = await sell([{ productId: water.id, quantity: 3 }], 15000);
    const byNumber = (await call("GET", `/returns/sales?q=${sale.orderNumber}`, cashier)).body.data;
    expect(byNumber[0]).toMatchObject({ id: sale.id, orderNumber: sale.orderNumber, total: 15000, returnedAmount: 0 });
    expect(byNumber[0].items[0]).toMatchObject({ name: "Вода 1,5 л", weighed: false, sold: 3, left: 3, leftAmount: 15000 });
    expect((await call("GET", "/returns/sales?q=4780000000991", cashier)).body.data.some((s: any) => s.id === sale.id)).toBe(true);
    expect((await call("GET", `/returns/sales?q=${encodeURIComponent("вода")}`, cashier)).body.data.some((s: any) => s.id === sale.id)).toBe(true);
    expect((await call("GET", "/returns/sales", cashier)).body.data.some((s: any) => s.id === sale.id)).toBe(true);
  });

  it("returns part of a check in cash: its share of the money, the goods back on the shelf, the drawer down", async () => {
    const sale = await sell([{ productId: water.id, quantity: 3 }], 15000);
    const [line] = await linesOf(sale.id);
    const before = { stock: await stock(water.id), drawer: (await current()).expectedCash };

    const res = await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 2 }], reason: "передумал" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ number: 1, method: "cash", amount: 10000, reason: "передумал" });
    expect(await stock(water.id)).toBe(before.stock + 2);
    const shift = await current();
    expect(shift.expectedCash).toBe(before.drawer - 10000);
    expect(shift.totalReturnsCash).toBe(10000);
    const move = await prisma.inventoryMovement.findFirstOrThrow({ where: { productId: water.id, reason: "Возврат №1" } });
    expect([move.type, move.quantity]).toEqual(["in", 2]);

    // Остаток строки — одна бутылка; больше не вернуть.
    const tooMuch = await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 2 }] });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/не больше 1 шт/);
    expect((await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 1 }], method: "card" })).body.data).toMatchObject({ amount: 5000, method: "card" });
    expect((await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 1 }] })).body.error).toMatch(/уже вернули/);
    expect((await current()).totalReturnsCard).toBe(5000);
  });

  it("does not give money back twice: no payment refund after a till return, no status games with a paid check", async () => {
    const sale = await sell([{ productId: water.id, quantity: 2 }], 10000);
    const [line] = await linesOf(sale.id);
    expect((await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 1 }] })).status).toBe(201);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: sale.id } });

    const refund = await call("POST", `/payments/${payment.id}/refund`, admin, { reason: "ещё раз" });
    expect(refund.status).toBe(409);
    expect(refund.body.error).toMatch(/уже был возврат на кассе/);

    // Оплаченный чек кнопкой статуса не трогают — иначе его можно было отменить и вернуть склад второй раз.
    expect((await call("PATCH", `/orders/${sale.id}/status`, admin, { status: "served" })).status).toBe(409);
    expect((await call("POST", `/orders/${sale.id}/cancel`, admin)).status).toBe(409);

    // Неоплаченный заказ «завершённым» не сделать.
    const unpaid = await call("POST", "/orders", cashier, { type: "takeaway", items: [{ productId: water.id, quantity: 1 }] });
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    const done = await call("PATCH", `/orders/${unpaid.body.data.id}/status`, admin, { status: "completed" });
    expect(done.status).toBe(409);
    expect(done.body.error).toMatch(/оплачен не полностью/);
  });

  it("keeps a defective item off the shelf", async () => {
    const sale = await sell([{ productId: water.id, quantity: 1 }], 5000);
    const [line] = await linesOf(sale.id);
    const before = await stock(water.id);
    expect((await giveBack({ orderId: sale.id, items: [{ orderItemId: line.id, quantity: 1, defective: true }] })).status).toBe(201);
    expect(await stock(water.id)).toBe(before);
    expect((await prisma.saleReturnItem.findFirstOrThrow({ where: { orderItemId: line.id } })).defective).toBe(true);
  });

  it("returns part of a weighed line by grams, and splits a check discount between the lines", async () => {
    const sale = await sell([{ productId: rice.id, quantity: 1, grams: 2000 }, { productId: water.id, quantity: 2 }], 52000, { discountAmount: 6000 });
    const [riceLine, waterLine] = await linesOf(sale.id);
    const before = await stock(rice.id);
    // чек 58 000 со скидкой 6 000 → оплачено 52 000; рис 48 000 × 52/58, полкило — четверть
    const res = await giveBack({ orderId: sale.id, items: [{ orderItemId: riceLine.id, grams: 500 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.amount).toBeCloseTo(10758.62, 2);
    expect(await stock(rice.id)).toBeCloseTo(before + 0.5, 5);
    // всё остальное — ровно остаток оплаченного, без копеек от округления
    const rest = await giveBack({ orderId: sale.id, items: [{ orderItemId: riceLine.id, grams: 1500 }, { orderItemId: waterLine.id, quantity: 2 }] });
    expect(res.body.data.amount + rest.body.data.amount).toBeCloseTo(52000, 2);
  });

  it("takes a debt sale back off the customer's debt — or refuses when the debt is smaller", async () => {
    const customer = (await call("POST", "/customers", cashier, { firstName: "Алишер", phone: "+998901112233" })).body.data;
    const res = await call("POST", "/orders/checkout", cashier, {
      type: "takeaway", cashShiftId: shiftId, items: [{ productId: water.id, quantity: 4 }], expectedTotal: 20000,
      payments: [{ method: "debt", amount: 20000 }], customerId: customer.id,
    });
    expect(res.status).toBe(201);
    const [line] = await linesOf(res.body.data.id);
    const back = await giveBack({ orderId: res.body.data.id, items: [{ orderItemId: line.id, quantity: 1 }], method: "debt" });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).debtBalance).toBe(15000);
    expect((await current()).totalReturnsDebt).toBe(5000);

    await prisma.customer.update({ where: { id: customer.id }, data: { debtBalance: 1000 } });
    const tooBig = await giveBack({ orderId: res.body.data.id, items: [{ orderItemId: line.id, quantity: 1 }], method: "debt" });
    expect(tooBig.status).toBe(409);
    expect(tooBig.body.error).toMatch(/верните деньгами/);

    const noCustomer = await sell([{ productId: water.id, quantity: 1 }], 5000);
    const [plain] = await linesOf(noCustomer.id);
    expect((await giveBack({ orderId: noCustomer.id, items: [{ orderItemId: plain.id, quantity: 1 }], method: "debt" })).status).toBe(409);
  });

  it("takes goods back without a check at today's price", async () => {
    await prisma.product.update({ where: { id: water.id }, data: { price: 5500 } });
    const before = await stock(water.id);
    const res = await giveBack({ items: [{ productId: water.id, quantity: 2 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ orderId: null, amount: 11000 });
    expect(await stock(water.id)).toBe(before + 2);
    const kg = await giveBack({ items: [{ productId: rice.id, grams: 750 }], method: "card" });
    expect(kg.body.data.amount).toBe(18000);
    expect((await giveBack({ items: [{ productId: water.id, quantity: 1 }], method: "debt" })).status).toBe(400);
    await prisma.product.update({ where: { id: water.id }, data: { price: 5000 } });
  });

  it("is done once even when the till sends it twice", async () => {
    const sale = await sell([{ productId: water.id, quantity: 1 }], 5000);
    const [line] = await linesOf(sale.id);
    const body = { orderId: sale.id, items: [{ orderItemId: line.id, quantity: 1 }] };
    const first = await giveBack(body, cashier, { "Idempotency-Key": "return-once-1" });
    const again = await giveBack(body, cashier, { "Idempotency-Key": "return-once-1" });
    expect(first.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.saleReturn.count({ where: { orderId: sale.id } })).toBe(1);
  });

  it("is closed to a cashier without the right, and hidden from a blind shift", async () => {
    await prisma.user.update({ where: { id: cashierId }, data: { canRefund: false, canSeeExpectedCash: false } });
    try {
      expect((await call("GET", "/auth/me", cashier)).body.data.permissions.canRefund).toBe(false);
      expect((await call("GET", "/returns/sales", cashier)).status).toBe(403);
      const res = await giveBack({ items: [{ productId: water.id, quantity: 1 }] });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Возврат товара вам закрыт/);
      const blind = await current();
      expect(blind.totalReturnsCash).toBeUndefined();
      expect(blind.expectedCash).toBeUndefined();
    } finally {
      await prisma.user.update({ where: { id: cashierId }, data: { canRefund: true, canSeeExpectedCash: true } });
    }
  });

  it("takes returns off the revenue, and keeps a returned product from being deleted", async () => {
    const dash = (await call("GET", "/reports/dashboard", admin)).body.data;
    const paid = (await prisma.payment.aggregate({ where: { tenantId: testTenantId, status: "completed" }, _sum: { amount: true } }))._sum.amount ?? 0;
    const returned = (await prisma.saleReturn.aggregate({ where: { tenantId: testTenantId }, _sum: { amount: true } }))._sum.amount ?? 0;
    expect(dash.todayRevenue).toBeCloseTo(paid - returned, 2);

    const gum = await prisma.product.create({ data: { tenantId: testTenantId, name: "Жвачка", price: 2000 } });
    await giveBack({ items: [{ productId: gum.id, quantity: 1 }] });
    expect((await call("DELETE", `/products/${gum.id}`, admin)).body.data).toEqual({ removed: "archived" });
  });
});
