import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Офлайн-режим кассы: продажа пробита без связи (только наличными) и дошла до
// сервера позже. Деньги уже взяты, поэтому сервер записывает её как было:
// время — когда пробили, цена — по которой продали, остаток — хоть в минус, с
// пометкой. Повтор той же продажи с тем же ключом второго чека не создаёт.

let adminToken: string;
let cashierToken: string;
let cashierId: string;
let shiftId: string;

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });

let keySeq = 0;
const newKey = () => `offline-test-${Date.now()}-${++keySeq}`;

interface Line {
  productId: string;
  quantity: number;
  grams?: number;
  unitPrice?: number;
}

function offlineSale(lines: Line[], opts: { soldAt?: Date; expectedTotal?: number; method?: string; shift?: string; cashier?: string | null } = {}) {
  const total = lines.reduce((sum, l) => sum + (l.unitPrice ?? 0) * l.quantity, 0);
  return {
    type: "takeaway",
    cashShiftId: opts.shift ?? shiftId,
    items: lines,
    expectedTotal: opts.expectedTotal ?? Math.round(total * 100) / 100,
    payment: { method: opts.method ?? "cash" },
    offline: { soldAt: (opts.soldAt ?? new Date(Date.now() - 3600_000)).toISOString(), ...(opts.cashier === null ? {} : { cashierId: opts.cashier ?? cashierId }) },
  };
}

const send = (body: unknown, key = newKey(), token = cashierToken) =>
  api("/orders/checkout", token, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } });

async function product(data: Record<string, unknown>) {
  return prisma.product.create({ data: { tenantId: testTenantId, trackInventory: true, ...data } as any });
}

describe("Offline sales from the shop register", () => {
  beforeAll(async () => {
    await setupTestData();
    const tokens = await getTokens(BASE_URL);
    adminToken = tokens.adminToken;
    cashierToken = tokens.cashierToken;
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS" } });
    const cashier = await prisma.user.findFirstOrThrow({ where: { tenantId: testTenantId, role: "cashier" } });
    cashierId = cashier.id;
    const shift = await prisma.cashShift.create({ data: { tenantId: testTenantId, userId: cashier.id, openingCash: 0, status: "open" } as any });
    shiftId = shift.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("records the sale at the time it was rung up, at the price that was charged, marked as offline", async () => {
    const bread = await product({ name: "Хлеб", price: 5000, currentStock: 10 });
    const soldAt = new Date(Date.now() - 5 * 3600_000);

    const res = await send(offlineSale([{ productId: bread.id, quantity: 2, unitPrice: 5000 }], { soldAt }));
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.total).toBe(10000);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: body.data.id }, include: { payments: true } });
    expect(order.offlineAt?.toISOString()).toBe(soldAt.toISOString());
    expect(order.createdAt.toISOString()).toBe(soldAt.toISOString()); // отчёты по дням и часам — по времени продажи
    expect(order.completedAt?.toISOString()).toBe(soldAt.toISOString());
    expect(order.payments[0].processedAt?.toISOString()).toBe(soldAt.toISOString());
    expect(order).toMatchObject({ status: "completed", cashShiftId: shiftId, offlineShortfall: false, offlinePriceChanged: false });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: bread.id } })).currentStock).toBe(8);
  });

  it("keeps the price the customer paid when the price changed meanwhile, and says so", async () => {
    const milk = await product({ name: "Молоко", price: 12000, currentStock: 10 }); // на кассе было 11 000

    const res = await send(offlineSale([{ productId: milk.id, quantity: 1, unitPrice: 11000 }]));
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.total).toBe(11000);
    expect(body.data.items[0].unitPrice).toBe(11000);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: body.data.id } })).toMatchObject({ offlinePriceChanged: true });
  });

  it("lets the balance go below zero when two registers sold the last item offline, and marks the order", async () => {
    const cola = await product({ name: "Кола", price: 9000, currentStock: 1 });

    const first = await send(offlineSale([{ productId: cola.id, quantity: 1, unitPrice: 9000 }]));
    const second = await send(offlineSale([{ productId: cola.id, quantity: 1, unitPrice: 9000 }]));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const secondOrder = await prisma.order.findUniqueOrThrow({ where: { id: ((await second.json()) as any).data.id } });

    expect(secondOrder.offlineShortfall).toBe(true);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: cola.id } })).currentStock).toBe(-1);
  });

  it("weighs goods at the price paid for that weight", async () => {
    const apples = await product({ name: "Яблоки", price: 18000, currentStock: 50, saleUnit: "кг" });

    const res = await send(offlineSale([{ productId: apples.id, quantity: 1, grams: 1500, unitPrice: 27000 }]));
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.total).toBe(27000);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: apples.id } })).currentStock).toBeCloseTo(48.5, 5);
  });

  it("is recorded once, however many times the register sends it", async () => {
    const water = await product({ name: "Вода", price: 3000, currentStock: 20 });
    const body = offlineSale([{ productId: water.id, quantity: 1, unitPrice: 3000 }]);
    const key = newKey();

    const a = await send(body, key);
    const b = await send(body, key);
    const c = await send(body, key);
    const ids = await Promise.all([a, b, c].map(async (r) => ((await r.json()) as any).data.id));

    expect([a.status, b.status, c.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.order.count({ where: { tenantId: testTenantId, items: { some: { productId: water.id } } } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: water.id } })).currentStock).toBe(19);
  });

  it("belongs to the shift it was rung up in, even if that shift was closed since", async () => {
    const tea = await product({ name: "Чай", price: 4000, currentStock: 10 });
    const closed = await prisma.cashShift.create({ data: { tenantId: testTenantId, userId: cashierId, openingCash: 0, status: "closed", closedAt: new Date() } as any });

    const res = await send(offlineSale([{ productId: tea.id, quantity: 1, unitPrice: 4000 }], { shift: closed.id }));
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.cashShiftId).toBe(closed.id);
  });

  it("is accepted for a product taken off sale since", async () => {
    const gum = await product({ name: "Жвачка", price: 2000, currentStock: 5, isActive: false });

    const res = await send(offlineSale([{ productId: gum.id, quantity: 1, unitPrice: 2000 }]));
    expect(res.status).toBe(201);
  });

  it("is credited to the cashier who rang it up, not to whoever is logged in when it arrives", async () => {
    const juice = await product({ name: "Сок", price: 7000, currentStock: 5 });

    const res = await send(offlineSale([{ productId: juice.id, quantity: 1, unitPrice: 7000 }]), newKey(), adminToken);
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: body.data.id } })).userId).toBe(cashierId);
  });

  it("refuses what an offline sale cannot be", async () => {
    const salt = await product({ name: "Соль", price: 1000, currentStock: 50 });
    const line = { productId: salt.id, quantity: 1, unitPrice: 1000 };

    // картой и по QR без связи не платят
    expect((await send(offlineSale([line], { method: "card" }))).status).toBe(400);
    // строка без цены
    expect((await send(offlineSale([{ productId: salt.id, quantity: 1 }], { expectedTotal: 1000 }))).status).toBe(400);
    // время в будущем
    expect((await send(offlineSale([line], { soldAt: new Date(Date.now() + 3600_000) }))).status).toBe(400);
    // слишком старая
    expect((await send(offlineSale([line], { soldAt: new Date(Date.now() - 40 * 24 * 3600_000) }))).status).toBe(400);
    // итог не сходится со строками
    expect((await send(offlineSale([line], { expectedTotal: 5000 }))).status).toBe(400);
    // чужой кассир
    expect((await send(offlineSale([line], { cashier: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: salt.id } })).currentStock).toBe(50);
  });

  it("leaves online sales exactly as strict as before", async () => {
    const soda = await product({ name: "Газировка", price: 6000, currentStock: 0 });

    const noStock = await api("/orders/checkout", cashierToken, {
      method: "POST",
      body: JSON.stringify({ type: "takeaway", cashShiftId: shiftId, items: [{ productId: soda.id, quantity: 1, unitPrice: 1 }], expectedTotal: 6000, payment: { method: "cash" } }),
    });
    expect(noStock.status).toBe(400); // без офлайн-пометки — в минус не продаём

    await prisma.product.update({ where: { id: soda.id }, data: { currentStock: 5 } });
    const cheap = await api("/orders/checkout", cashierToken, {
      method: "POST",
      body: JSON.stringify({ type: "takeaway", cashShiftId: shiftId, items: [{ productId: soda.id, quantity: 1, unitPrice: 1 }], expectedTotal: 1, payment: { method: "cash" } }),
    });
    expect(cheap.status).toBe(409); // цену онлайн-продажи по-прежнему считает сервер
  });

  it("shows offline sales and their marks in the order list", async () => {
    const res = await api("/orders?limit=100", adminToken);
    const body = (await res.json()) as any;
    const offline = body.data.filter((o: any) => o.offlineAt);
    expect(offline.length).toBeGreaterThanOrEqual(5);
    expect(offline.some((o: any) => o.offlineShortfall)).toBe(true);
    expect(offline.some((o: any) => o.offlinePriceChanged)).toBe(true);
  });
});
