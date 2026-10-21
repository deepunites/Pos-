import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Приходы. README: «Приход обновляет себестоимость; цена продажи меняется
// только если её задали явно или у категории есть ненулевая наценка».
// По коду пересчёт цены по наценке — по запросу (updateSalePrice), а у
// нового товара цена считается всегда.

let admin: string;
let cashier: string;
let seq = 0;

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function category(markupPercent: number) {
  seq += 1;
  return prisma.category.create({ data: { tenantId: testTenantId, name: `Категория ${seq}`, markupPercent } });
}

async function product(categoryId: string, data: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.product.create({
    data: { tenantId: testTenantId, categoryId, name: `Товар ${seq}`, sku: `REC-${seq}`, price: 100, costPrice: 50, currentStock: 10, trackInventory: true, ...data },
  });
}

const receive = (items: unknown[], extra: Record<string, unknown> = {}, token = admin) =>
  call("POST", "/stock-receipts", token, { items, ...extra });
const row = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });

describe("Stock receipts", () => {
  beforeAll(async () => {
    await setupTestData();
    const tokens = await getTokens(BASE_URL);
    admin = tokens.adminToken;
    cashier = tokens.cashierToken;
    await prisma.tenant.update({ where: { id: testTenantId }, data: { defaultMarkupPercent: 20 } });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("adds stock, takes the new cost price and leaves the shelf price alone", async () => {
    const cat = await category(25);
    const p = await product(cat.id);

    const res = await receive([{ productId: p.id, quantity: 4, costPrice: 60 }], { supplierName: "ООО «Барака»" });

    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBe(240);
    expect(await row(p.id)).toMatchObject({ currentStock: 14, costPrice: 60, price: 100 });
    const moves = await prisma.inventoryMovement.findMany({ where: { productId: p.id } });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "in", quantity: 4, referenceId: res.body.data.id });
  });

  it("sets the shelf price when it is given explicitly", async () => {
    const p = await product((await category(0)).id);
    await receive([{ productId: p.id, quantity: 1, costPrice: 70, salePrice: 130 }]);
    expect((await row(p.id)).price).toBe(130);
  });

  it("reprices from the category markup when asked to", async () => {
    const p = await product((await category(25)).id);
    await receive([{ productId: p.id, quantity: 1, costPrice: 80, updateSalePrice: true }]);
    expect((await row(p.id)).price).toBe(100);
  });

  it("refuses to reprice by a zero markup, and writes nothing", async () => {
    const p = await product((await category(0)).id);

    const res = await receive([{ productId: p.id, quantity: 5, costPrice: 80, updateSalePrice: true }]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/наценка категории 0%/);
    expect(await row(p.id)).toMatchObject({ currentStock: 10, costPrice: 50, price: 100 });
    expect(await prisma.stockReceipt.count({ where: { items: { some: { productId: p.id } } } })).toBe(0);
  });

  it("creates a new product and its category, priced by the shop's default markup", async () => {
    const res = await receive([
      { newProduct: { name: "Айран 0,5 л", newCategoryName: "Молочка" }, quantity: 12, costPrice: 5000 },
      { newProduct: { name: "Кефир 1 л", newCategoryName: "молочка" }, quantity: 6, costPrice: 8000 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const categories = await prisma.category.findMany({ where: { tenantId: testTenantId, name: { equals: "Молочка", mode: "insensitive" } } });
    expect(categories).toHaveLength(1);
    expect(categories[0].markupPercent).toBe(20);

    const ayran = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Айран 0,5 л" } });
    expect(ayran).toMatchObject({ currentStock: 12, costPrice: 5000, price: 6000, categoryId: categories[0].id });
  });

  it("keeps the barcode and the supplier's SKU of a new product", async () => {
    const res = await receive([
      { newProduct: { name: "Тан 0,5 л", barcode: "4780000555001", sku: "TAN-05" }, quantity: 3, costPrice: 4000, salePrice: 5500 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const tan = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Тан 0,5 л" } });
    expect(tan).toMatchObject({ barcode: "4780000555001", sku: "TAN-05", price: 5500, currentStock: 3 });
  });

  it("files a new product under a shelf category of that name whatever the case, never under recipe ingredients", async () => {
    const ingredients = await prisma.category.create({ data: { tenantId: testTenantId, name: "Сыры", isIngredient: true, markupPercent: 0 } });
    const sweets = await prisma.category.create({ data: { tenantId: testTenantId, name: "Сладости", markupPercent: 50 } });

    const res = await receive([
      { newProduct: { name: "Сыр Гауда", newCategoryName: "Сыры" }, quantity: 2, costPrice: 1000 },
      { newProduct: { name: "Халва ванильная", newCategoryName: "СЛАДОСТИ" }, quantity: 3, costPrice: 1000 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const cheese = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Сыр Гауда" }, include: { category: true } });
    expect(cheese.categoryId).not.toBe(ingredients.id);
    // Новая «полка» с наценкой заведения (20%), а не наценка ингредиентов (0%).
    expect(cheese.category).toMatchObject({ name: "Сыры", isIngredient: false, markupPercent: 20 });
    expect(cheese.price).toBe(1200);
    const halva = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Халва ванильная" } });
    expect(halva).toMatchObject({ categoryId: sweets.id, price: 1500 });
  });

  it("books two lines of the same product one after the other", async () => {
    const p = await product((await category(25)).id);
    const before = (await row(p.id)).updatedAt;

    const res = await receive([
      { productId: p.id, quantity: 4, costPrice: 60, salePrice: 130 },
      { productId: p.id, quantity: 1.5, costPrice: 70 },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.totalAmount).toBe(345);
    // Остаток — оба прихода, себестоимость — последняя, цена — заданная в первой строке.
    const after = await row(p.id);
    expect(after).toMatchObject({ currentStock: 15.5, costPrice: 70, price: 130 });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(Math.abs(after.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
    const moves = await prisma.inventoryMovement.findMany({ where: { productId: p.id } });
    expect(moves.map((m) => [m.type, m.quantity]).sort()).toEqual([["in", 1.5], ["in", 4]]);
  });

  it("takes at most 2000 lines in one receipt", async () => {
    const p = await product((await category(0)).id);
    const res = await receive(Array.from({ length: 2001 }, () => ({ productId: p.id, quantity: 1, costPrice: 1 })));
    expect(res.status).toBe(400);
    expect((await row(p.id)).currentStock).toBe(10);
  });

  it("does not create a new product without a price when the markup is zero", async () => {
    const cat = await category(0);
    await prisma.tenant.update({ where: { id: testTenantId }, data: { defaultMarkupPercent: 0 } });
    try {
      const res = await receive([{ newProduct: { name: "Без цены", categoryId: cat.id }, quantity: 1, costPrice: 10 }]);
      expect(res.status).toBe(400);
      expect(await prisma.product.count({ where: { tenantId: testTenantId, name: "Без цены" } })).toBe(0);
    } finally {
      await prisma.tenant.update({ where: { id: testTenantId }, data: { defaultMarkupPercent: 20 } });
    }
  });

  it("refuses another shop's product, and writes nothing", async () => {
    const other = await prisma.tenant.create({ data: { name: "Чужая", slug: "other-receipts" } });
    const foreignCat = await prisma.category.create({ data: { tenantId: other.id, name: "Чужая категория" } });
    const foreign = await prisma.product.create({ data: { tenantId: other.id, categoryId: foreignCat.id, name: "Чужой", price: 1, currentStock: 1 } });
    const mine = await product((await category(0)).id);

    const res = await receive([
      { productId: mine.id, quantity: 1, costPrice: 1 },
      { productId: foreign.id, quantity: 100, costPrice: 1 },
    ]);

    expect(res.status).toBe(404);
    expect((await row(foreign.id)).currentStock).toBe(1);
    expect((await row(mine.id)).currentStock).toBe(10);
  });

  it("is open to a cashier at the register, but listing and deleting are not", async () => {
    const p = await product((await category(0)).id);
    const res = await receive([{ productId: p.id, quantity: 1, costPrice: 50 }], {}, cashier);
    expect(res.status).toBe(201);

    expect((await call("GET", "/stock-receipts", cashier)).status).toBe(403);
    expect((await call("DELETE", `/stock-receipts/${res.body.data.id}`, cashier)).status).toBe(403);
  });

  it("deleting a receipt takes its goods back off the shelf, even below zero", async () => {
    const p = await product((await category(0)).id, { currentStock: 0 });
    const receipt = (await receive([{ productId: p.id, quantity: 5, costPrice: 50 }])).body.data;
    await prisma.product.update({ where: { id: p.id }, data: { currentStock: 2 } }); // три уже продали

    expect((await call("DELETE", `/stock-receipts/${receipt.id}`, admin)).status).toBe(200);

    expect((await row(p.id)).currentStock).toBe(-3);
    const reversal = await prisma.inventoryMovement.findFirstOrThrow({ where: { productId: p.id, type: "out" } });
    expect(reversal).toMatchObject({ quantity: 5, referenceId: receipt.id });
    expect(reversal.reason).toMatch(/Отмена прихода/);
    expect((await call("DELETE", `/stock-receipts/${receipt.id}`, admin)).status).toBe(404);
  });

  it("finds receipts by supplier whatever the case, and by day", async () => {
    const p = await product((await category(0)).id);
    await receive([{ productId: p.id, quantity: 1, costPrice: 1 }], { supplierName: "ИП Каримов" });

    const bySupplier = await call("GET", `/stock-receipts?supplierName=${encodeURIComponent("каримов")}`, admin);
    expect(bySupplier.status).toBe(200);
    expect((bySupplier.body.data as any[]).map((r) => r.supplierName)).toContain("ИП Каримов");

    const future = await call("GET", "/stock-receipts?dateFrom=2099-01-01&dateTo=2099-01-02", admin);
    expect(future.body.data).toHaveLength(0);
  });
});
