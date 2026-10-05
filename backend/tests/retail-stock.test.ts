import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Магазин ведёт остаток у каждого товара: пробитый чек его уменьшает, а ноль
// по учёту продажу не останавливает — остаток уходит в минус (2026-10-05).
// У кафе всё как раньше: учёт только где включён, не хватает — отказ.

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
const sell = (productId: string, quantity: number, price: number) =>
  call("POST", "/orders/checkout", cashier, { type: "takeaway", cashShiftId: shiftId, items: [{ productId, quantity }], expectedTotal: price * quantity, payment: { method: "cash" } });
const stockOf = async (id: string) => prisma.product.findUniqueOrThrow({ where: { id }, select: { currentStock: true, trackInventory: true } });
const setType = (businessType: string) => prisma.tenant.update({ where: { id: testTenantId }, data: { businessType } });

describe("Shop stock", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 0 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("goes down with every paid check, into the minus when nothing was received", async () => {
    const water = await prisma.product.create({ data: { tenantId: testTenantId, name: "Вода 0,5 л", price: 3000, trackInventory: true, currentStock: 1 } });
    const res = await sell(water.id, 3, 3000);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stockOf(water.id)).toEqual({ currentStock: -2, trackInventory: true });
    const moves = await prisma.inventoryMovement.findMany({ where: { productId: water.id } });
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([["out", 3]]);
  });

  it("counts a product entered without stock tracking from its first sale", async () => {
    const bag = await prisma.product.create({ data: { tenantId: testTenantId, name: "Пакет", price: 500, trackInventory: false, currentStock: 0 } });
    expect((await sell(bag.id, 2, 500)).status).toBe(201);
    expect(await stockOf(bag.id)).toEqual({ currentStock: -2, trackInventory: true });
  });

  it("is tracked for every new product: by hand, from a file — and cannot be switched off", async () => {
    const created = await call("POST", "/products", admin, { name: "Спички", price: 1000, trackInventory: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.trackInventory).toBe(true);
    const updated = await call("PUT", `/products/${created.body.data.id}`, admin, { trackInventory: false });
    expect(updated.body.data.trackInventory).toBe(true);

    const imported = await call("POST", "/products/import", admin, { rows: [{ row: 2, name: "Соль 1 кг", price: 4000 }], apply: true });
    expect(imported.status).toBe(200);
    expect(await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Соль 1 кг" }, select: { trackInventory: true, currentStock: true } })).toEqual({ trackInventory: true, currentStock: 0 });
  });

  it("switches tracking on for the shop's old products, and leaves cafés alone", async () => {
    const old = await prisma.product.create({ data: { tenantId: testTenantId, name: "Старый товар", price: 1, trackInventory: false } });
    const ingredient = await prisma.product.create({ data: { tenantId: testTenantId, name: "Ингредиент", price: 1, trackInventory: false, isIngredient: true } });
    const cafe = await prisma.tenant.create({ data: { name: "Кафе", slug: "cafe-stock", email: "c@x.uz", businessType: "cafe" } });
    const dish = await prisma.product.create({ data: { tenantId: cafe.id, name: "Плов", price: 1, trackInventory: false } });

    await prisma.$executeRawUnsafe(readFileSync(new URL("../prisma/migrations/20261005120000_retail_track_stock/migration.sql", import.meta.url), "utf8"));

    expect((await stockOf(old.id)).trackInventory).toBe(true);
    expect((await stockOf(ingredient.id)).trackInventory).toBe(false);
    expect((await stockOf(dish.id)).trackInventory).toBe(false);
  });

  it("stays as it was in a café: untracked goods are not counted, a short one is refused", async () => {
    await setType("cafe");
    try {
      const tea = await prisma.product.create({ data: { tenantId: testTenantId, name: "Чай", price: 5000, trackInventory: false, currentStock: 0 } });
      expect((await sell(tea.id, 1, 5000)).status).toBe(201);
      expect(await stockOf(tea.id)).toEqual({ currentStock: 0, trackInventory: false });

      const cake = await prisma.product.create({ data: { tenantId: testTenantId, name: "Торт", price: 30000, trackInventory: true, currentStock: 0 } });
      const short = await sell(cake.id, 1, 30000);
      expect(short.status).toBe(400);
      expect(short.body.error).toMatch(/Недостаточно товара «Торт»/);
    } finally {
      await setType("retail");
    }
  });
});
