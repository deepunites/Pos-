import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";
import { parseAmount, weighedUnit } from "../src/modules/products/product.import.js";

// Импорт товаров из Excel/CSV (своя выгрузка, шаблон, файл из 1С) и выгрузка.

let admin: string;
let cashier: string;

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const importRows = (rows: unknown[], apply: boolean, token = admin) => call("POST", "/products/import", token, { rows, apply });

describe("Products import and export", () => {
  let cola: string;
  let tea: string;

  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS" } });
    cola = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Coca-Cola 1 л", barcode: "5449000000439", sku: "CC-1", price: 8500, costPrice: 7000, trackInventory: true, currentStock: 20 } })).id;
    tea = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Чай Ahmad 100 г", barcode: "054881005500", sku: "AH-100", price: 16500, trackInventory: true, currentStock: 10 } })).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  const file = [
    { row: 2, name: "Coca-Cola 1 л", barcode: "5449000000439", price: "9 000", stock: 24 },
    { row: 3, name: "Чай Ahmad 100 г", barcode: "54881005500", stock: "12" }, // EAN-13 без ведущего нуля — тот же товар
    { row: 4, sku: "cc-1", price: 9000 }, // артикул той же колы — повтор
    { row: 5, name: "Халва подсолнечная 350 г", barcode: "4780011111111", sku: "HV-350", category: "Сладости", price: "16 000", costPrice: "12 500,50", stock: 30 },
    { row: 6, name: "Рис девзира", category: "Бакалея", unit: "кг", price: 24000, stock: "50,5" },
    { row: 7, name: "", price: 1000 },
    { row: 8, name: "Печенье", price: "двадцать" },
    { row: 9, name: "Без цены", barcode: "4780022222222" },
    { row: 10, name: "Coca-Cola дубль", barcode: "5449000000439", price: 1 },
  ];

  it("checks the file without writing anything", async () => {
    const before = await prisma.product.count({ where: { tenantId: testTenantId } });
    const res = await importRows(file, false);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { summary, items, applied } = res.body.data;
    expect(applied).toBe(false);
    expect(summary).toMatchObject({ create: 2, update: 2, same: 0, error: 5, priceChanged: 1, stockChanged: 2 });

    const byRow = (row: number) => items.find((i: any) => i.row === row);
    expect(byRow(2)).toMatchObject({ kind: "update", changes: [{ field: "price", from: 8500, to: 9000 }, { field: "stock", from: 20, to: 24 }] });
    expect(byRow(3)).toMatchObject({ kind: "update", changes: [{ field: "stock", from: 10, to: 12 }] });
    expect(byRow(4).message).toBe("этот товар уже в строке 2");
    expect(byRow(7).message).toBe("нет названия");
    expect(byRow(8).message).toMatch(/«двадцать» — не число/);
    expect(byRow(9).message).toBe("нет цены продажи");
    expect(byRow(10).message).toMatch(/штрихкод 5449000000439 уже в строке 2/);
    // ошибки — первыми
    expect(items[0].kind).toBe("error");

    expect(await prisma.product.count({ where: { tenantId: testTenantId } })).toBe(before);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: cola } })).price).toBe(8500);
  });

  it("writes new and changed products, sets stock as in the file and logs the difference", async () => {
    const res = await importRows(file, true);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.applied).toBe(true);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: cola } })).toMatchObject({ price: 9000, currentStock: 24 });
    // Excel съел ведущий ноль — штрихкод в базе остался правильным.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: tea } })).toMatchObject({ price: 16500, currentStock: 12, barcode: "054881005500" });
    const moves = await prisma.inventoryMovement.findMany({ where: { productId: cola, reason: "Импорт" } });
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([["in", 4]]);

    const halva = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Халва подсолнечная 350 г" }, include: { category: true } });
    expect(halva).toMatchObject({ barcode: "4780011111111", sku: "HV-350", price: 16000, costPrice: 12500.5, currentStock: 30, trackInventory: true });
    expect(halva.category?.name).toBe("Сладости");
    const rice = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Рис девзира" } });
    expect(rice).toMatchObject({ unit: "kg", saleUnit: "кг", currentStock: 50.5 });
    expect(await prisma.product.count({ where: { tenantId: testTenantId, name: { in: ["Печенье", "Без цены", "Coca-Cola дубль"] } } })).toBe(0);
  });

  it("leaves stock alone when the cell is empty, and reports unchanged rows", async () => {
    const res = await importRows([{ row: 2, barcode: "5449000000439", name: "Coca-Cola 1 л", price: 9000 }], true);
    expect(res.body.data.summary).toMatchObject({ same: 1, update: 0 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: cola } })).currentStock).toBe(24);
  });

  it("never touches another shop's products", async () => {
    const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-import", email: "i@x.uz" } });
    const theirs = await prisma.product.create({ data: { tenantId: other.id, name: "Чужая вода", barcode: "4780099999917", price: 1 } });
    const res = await importRows([{ row: 2, name: "Вода", barcode: "4780099999917", price: 3000 }], true);
    expect(res.body.data.summary.create).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: theirs.id } })).price).toBe(1);
  });

  it("is for the admin and the manager only", async () => {
    expect((await importRows([{ row: 2, name: "X", price: 1 }], false, cashier)).status).toBe(403);
    expect((await call("GET", "/products/export", cashier)).status).toBe(403);
  });

  it("exports every product with its category, unit and stock", async () => {
    const res = await call("GET", "/products/export", admin);
    expect(res.status).toBe(200);
    const rice = res.body.data.find((p: any) => p.name === "Рис девзира");
    expect(rice).toMatchObject({ category: "Бакалея", unit: "кг", price: 24000, stock: 50.5 });
    expect(res.body.data.find((p: any) => p.name === "Coca-Cola 1 л")).toMatchObject({ barcode: "5449000000439", sku: "CC-1", unit: "шт", stock: 24 });
  });

  it("leaves products taken off sale out of the export", async () => {
    await prisma.product.create({ data: { tenantId: testTenantId, name: "Снятый с продажи", price: 1, isActive: false } });
    const res = await call("GET", "/products/export", admin);
    expect(res.body.data.some((p: any) => p.name === "Снятый с продажи")).toBe(false);
  });

  it("matches goods without barcode and SKU by name — a re-import does not duplicate them", async () => {
    await prisma.product.create({ data: { tenantId: testTenantId, name: "Нон белый", price: 4000, trackInventory: true, currentStock: 5 } });
    const before = await prisma.product.count({ where: { tenantId: testTenantId } });
    const res = await importRows([{ row: 2, name: "  нон   БЕЛЫЙ ", price: "4 500" }], true);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ kind: "update", changes: [{ field: "price", from: 4000, to: 4500 }] });
    expect(await prisma.product.count({ where: { tenantId: testTenantId } })).toBe(before);
  });

  it("refuses to guess between two goods with the same name and no codes, and between two new rows", async () => {
    await prisma.product.createMany({ data: [1, 2].map(() => ({ tenantId: testTenantId, name: "Самса", price: 6000 })) });
    const res = await importRows([{ row: 2, name: "Самса", price: 7000 }, { row: 3, name: "Лепёшка новая", price: 3000 }, { row: 4, name: "лепёшка новая", price: 3000 }], false);
    const byRow = (row: number) => res.body.data.items.find((i: any) => i.row === row);
    expect(byRow(2).message).toBe("товаров «Самса» несколько — укажите артикул или штрихкод");
    expect(byRow(3).kind).toBe("create");
    expect(byRow(4).message).toBe("товар «лепёшка новая» уже в строке 3");
  });

  it("brings an archived product back on sale when the file has it", async () => {
    const id = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Квас 1 л", barcode: "4780055500017", price: 7000, isActive: false } })).id;
    const res = await importRows([{ row: 2, name: "Квас 1 л", barcode: "4780055500017", price: 7000 }], true);
    expect(res.body.data.items[0]).toMatchObject({ kind: "update", changes: [{ field: "active" }] });
    expect((await prisma.product.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
  });

  describe("cells", () => {
    it("reads sum prices with English thousands separators, but keeps kilograms decimal", () => {
      expect(parseAmount("14,000", true)).toBe(14000);
      expect(parseAmount("1,250,000", true)).toBe(1250000);
      expect(parseAmount("14,5", true)).toBe(14.5);
      expect(parseAmount("1,500")).toBe(1.5); // остаток в кг
    });

    it("reads amounts the way people type them", () => {
      expect(parseAmount("9 000")).toBe(9000);
      expect(parseAmount("13 000,50")).toBe(13000.5);
      expect(parseAmount("1.234,5")).toBe(1234.5);
      expect(parseAmount("1,234.5")).toBe(1234.5);
      expect(parseAmount("15 000 сўм")).toBe(15000);
      expect(parseAmount(42)).toBe(42);
      expect(parseAmount("")).toBeUndefined();
      expect(parseAmount(null)).toBeUndefined();
      expect(parseAmount("двадцать")).toBeNaN();
    });

    it("knows weighed units", () => {
      expect(weighedUnit("кг")).toBe(true);
      expect(weighedUnit("KG")).toBe(true);
      expect(weighedUnit("шт.")).toBe(false);
      expect(weighedUnit("")).toBeUndefined();
    });
  });
});
