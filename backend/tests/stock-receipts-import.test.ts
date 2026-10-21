import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Приход из Excel/CSV: один файл — один документ прихода. Новые товары
// создаются, у знакомых растёт остаток и меняется себестоимость, цена продажи —
// только если она есть в файле.

let admin: string;
let cashier: string;

const call = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
};
const importReceipt = (rows: unknown[], apply: boolean, extra: Record<string, unknown> = {}, token = admin, headers: Record<string, string> = {}) =>
  call("POST", "/stock-receipts/import", token, { rows, apply, ...extra }, headers);
const product = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
const receipts = () => prisma.stockReceipt.count({ where: { tenantId: testTenantId } });

// Как файл владельца: «Название | Категория | Ед. измерения | Остаток | Себестоимость | Цена продажи».
const DRINKS = [
  "Coca-Cola 0,5 л", "Coca-Cola 1 л", "Coca-Cola 1,5 л", "Fanta 0,5 л", "Fanta 1 л", "Sprite 0,5 л",
  "Sprite 1 л", "Pepsi 0,5 л", "Pepsi 1 л", "Mirinda 0,5 л", "7Up 0,5 л", "Nestea 0,5 л",
  "Bonaqua 0,5 л", "Bonaqua 1,5 л", "Hydrolife 0,5 л", "Flash Up 0,45 л", "Adrenaline Rush 0,25 л", "Burn 0,5 л",
];
const drinks = DRINKS.map((name, i) => ({
  row: i + 2,
  name,
  category: "Напитки",
  unit: "шт",
  stock: 5 + (i % 3),
  costPrice: 6000 + 500 * (i % 4),
  price: 8000 + 1000 * (i % 4),
}));
// Ячейки CSV приходят текстом — «6 000», «8 000».
drinks[0] = { ...drinks[0], stock: "5" as unknown as number, costPrice: "6 000" as unknown as number, price: "8 000" as unknown as number };
const drinksQuantity = drinks.reduce((s, d) => s + Number(d.stock), 0);
const drinksCost = DRINKS.reduce((s, _, i) => s + (5 + (i % 3)) * (6000 + 500 * (i % 4)), 0);
const drinksSale = DRINKS.reduce((s, _, i) => s + (5 + (i % 3)) * (8000 + 1000 * (i % 4)), 0);

describe("Stock receipt from a spreadsheet", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", defaultMarkupPercent: 0 } });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("shows what the drinks file will do without writing anything", async () => {
    const before = await prisma.product.count({ where: { tenantId: testTenantId } });

    const res = await importReceipt(drinks, false);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { applied, summary, items, receipt } = res.body.data;
    expect(applied).toBe(false);
    expect(receipt).toBeUndefined();
    expect(summary).toEqual({ existing: 0, new: 18, error: 0, quantity: drinksQuantity, totalCost: drinksCost, totalSale: drinksSale });
    expect(items).toHaveLength(18);
    expect(items[0]).toMatchObject({ row: 2, kind: "new", name: "Coca-Cola 0,5 л", quantity: 5, costPrice: 6000, salePrice: 8000, currentPrice: null, priceChanged: false, sum: 30000 });

    expect(await prisma.product.count({ where: { tenantId: testTenantId } })).toBe(before);
    expect(await receipts()).toBe(0);
  });

  it("books the drinks file as one receipt and creates the goods", async () => {
    const res = await importReceipt(drinks, true, { supplierName: "ООО «Ichimliklar»", invoiceNumber: "НК-118" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { applied, summary, receipt } = res.body.data;
    expect(applied).toBe(true);
    expect(summary).toMatchObject({ new: 18, existing: 0, error: 0, totalCost: drinksCost });
    expect(receipt).toMatchObject({ receiptNumber: "НК-118", totalAmount: drinksCost });

    expect(await receipts()).toBe(1);
    const doc = await prisma.stockReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true } });
    expect(doc).toMatchObject({ supplierName: "ООО «Ichimliklar»", invoiceNumber: "НК-118", totalAmount: drinksCost });
    expect(doc.items).toHaveLength(18);

    const categories = await prisma.category.findMany({ where: { tenantId: testTenantId, name: "Напитки" } });
    expect(categories).toHaveLength(1);
    const cola = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Coca-Cola 0,5 л" } });
    expect(cola).toMatchObject({ price: 8000, costPrice: 6000, currentStock: 5, unit: "piece", trackInventory: true, categoryId: categories[0].id });
    const burn = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Burn 0,5 л" } });
    expect(burn).toMatchObject({ price: 9000, costPrice: 6500, currentStock: 7 });
    const moves = await prisma.inventoryMovement.findMany({ where: { productId: cola.id } });
    expect(moves.map((m) => [m.type, m.quantity, m.referenceId])).toEqual([["in", 5, receipt.id]]);

    // Документ — на странице «Приходы».
    const list = await call("GET", "/stock-receipts", admin);
    expect((list.body.data as any[]).map((r) => r.id)).toContain(receipt.id);
  });

  it("knows the goods it created on the next delivery of the same file", async () => {
    const res = await importReceipt(drinks, false);
    expect(res.body.data.summary).toMatchObject({ existing: 18, new: 0, error: 0 });
    expect(res.body.data.items[0]).toMatchObject({ kind: "existing", currentPrice: 8000, salePrice: 8000, priceChanged: false });
  });

  describe("goods the shop already has", () => {
    let cola: string;
    let tea: string;
    let halva: string;
    let non: string;
    let archivedNon: string;

    beforeAll(async () => {
      const make = (data: Record<string, unknown>) =>
        prisma.product.create({ data: { tenantId: testTenantId, trackInventory: true, ...data } as any }).then((p) => p.id);
      cola = await make({ name: "Coca-Cola 1 л ПЭТ", barcode: "5449000000439", price: 8500, costPrice: 7000, currentStock: 20 });
      tea = await make({ name: "Чай Ahmad 100 г", barcode: "054881005500", sku: "AH-100", price: 16500, costPrice: 12000, currentStock: 10 });
      halva = await make({ name: "Халва 350 г", sku: "HV-350", price: 16000, costPrice: 12000, currentStock: 3 });
      non = await make({ name: "Нон белый", price: 4000, costPrice: 2500, currentStock: 5 });
      // Снятый с продажи тёзка не мешает узнать товар по названию.
      archivedNon = await make({ name: "Нон белый", price: 3500, currentStock: 0, isActive: false });
      await prisma.product.createMany({ data: [1, 2].map(() => ({ tenantId: testTenantId, name: "Самса", price: 6000 })) });
    });

    const file = [
      { row: 2, name: "Кола", barcode: "5449000000439", stock: 24, costPrice: "7 200", price: "9 000" },
      { row: 3, name: "Чай", barcode: "54881005500", stock: "12", costPrice: 12500 }, // Excel съел ведущий ноль
      { row: 4, name: "Халва", sku: "hv-350", stock: 4, costPrice: 13000, price: 16000 },
      { row: 5, name: "  нон   БЕЛЫЙ ", stock: 10, costPrice: 3000 },
      { row: 6, name: "Самса", stock: 1, costPrice: 5000 },
      { row: 7, name: "Чай ещё раз", sku: "AH-100", stock: 1, costPrice: 1 },
      { row: 8, name: "Сок новый", barcode: "4780011111111", stock: 0, costPrice: 1, price: 2 },
      { row: 9, name: "Печенье", stock: 1, costPrice: "дорого", price: 3000 },
      { row: 10, name: "", barcode: "4780022222222", stock: 1, costPrice: 100, price: 200 },
      { row: 11, name: "Без количества", costPrice: 1, price: 2 },
      { row: 12, name: "Без себестоимости", stock: 1, price: 2 },
      { row: 13, name: "Лепёшка", stock: 3, costPrice: 2000, price: 3000 },
      { row: 14, name: "лепёшка", stock: 1, costPrice: 2000, price: 3000 },
      { row: 15, name: "Новинка без цены", barcode: "4780033333333", stock: 1, costPrice: 1000 },
    ];
    const valid = file.filter((r) => [2, 3, 4, 5, 13].includes(r.row));

    it("matches them by barcode, SKU and name, and explains every bad row", async () => {
      const res = await importReceipt(file, false);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const { summary, items } = res.body.data;
      expect(summary).toEqual({
        existing: 4,
        new: 1,
        error: 9,
        quantity: 24 + 12 + 4 + 10 + 3,
        totalCost: 24 * 7200 + 12 * 12500 + 4 * 13000 + 10 * 3000 + 3 * 2000,
        totalSale: 24 * 9000 + 12 * 16500 + 4 * 16000 + 10 * 4000 + 3 * 3000,
      });

      const byRow = (row: number) => items.find((i: any) => i.row === row);
      expect(byRow(2)).toMatchObject({ kind: "existing", productId: cola, name: "Coca-Cola 1 л ПЭТ", salePrice: 9000, currentPrice: 8500, priceChanged: true, sum: 172800 });
      expect(byRow(3)).toMatchObject({ kind: "existing", productId: tea, salePrice: null, currentPrice: 16500, priceChanged: false });
      expect(byRow(4)).toMatchObject({ kind: "existing", productId: halva, priceChanged: false });
      expect(byRow(5)).toMatchObject({ kind: "existing", productId: non, name: "Нон белый" });
      expect(byRow(6).message).toBe("товаров «Самса» несколько — укажите артикул или штрихкод");
      expect(byRow(7).message).toBe("этот товар уже в строке 3");
      expect(byRow(8).message).toBe("количество должно быть больше нуля");
      expect(byRow(9).message).toBe("себестоимость «дорого» — не число");
      expect(byRow(10).message).toBe("нет названия");
      expect(byRow(11).message).toBe("нет количества");
      expect(byRow(12).message).toBe("нет себестоимости");
      expect(byRow(13)).toMatchObject({ kind: "new", name: "Лепёшка" });
      expect(byRow(14).message).toBe("этот товар уже в строке 13");
      expect(byRow(15).message).toMatch(/нет цены продажи/);
      // ошибки — первыми, по порядку строк
      expect(items.slice(0, 9).map((i: any) => i.row)).toEqual([6, 7, 8, 9, 10, 11, 12, 14, 15]);
    });

    it("refuses to book a file with errors, and writes nothing", async () => {
      const res = await importReceipt(file, true);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("В файле есть ошибки — исправьте строки и загрузите снова");
      expect(await product(cola)).toMatchObject({ currentStock: 20, costPrice: 7000, price: 8500 });
      expect(await receipts()).toBe(1); // только приход напитков
      expect(await prisma.product.count({ where: { tenantId: testTenantId, name: "Лепёшка" } })).toBe(0);
    });

    it("adds stock and takes the cost, and sets the sale price only where the file has one", async () => {
      const res = await importReceipt(valid, true, { supplierName: "ИП Каримов" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const total = 24 * 7200 + 12 * 12500 + 4 * 13000 + 10 * 3000 + 3 * 2000;
      expect(res.body.data.receipt.totalAmount).toBe(total);
      expect(res.body.data.receipt.receiptNumber).toMatch(/^ПР-\d{4}$/);

      expect(await product(cola)).toMatchObject({ currentStock: 44, costPrice: 7200, price: 9000 });
      expect(await product(tea)).toMatchObject({ currentStock: 22, costPrice: 12500, price: 16500, barcode: "054881005500" });
      expect(await product(halva)).toMatchObject({ currentStock: 7, costPrice: 13000, price: 16000 });
      expect(await product(non)).toMatchObject({ currentStock: 15, costPrice: 3000, price: 4000 });
      // Его строка узнала активный «Нон белый» — архивный тёзка так и остался снятым с продажи.
      expect(await product(archivedNon)).toMatchObject({ currentStock: 0, price: 3500, isActive: false });
      const lepyoshka = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Лепёшка" } });
      expect(lepyoshka).toMatchObject({ currentStock: 3, costPrice: 2000, price: 3000, categoryId: null });

      const doc = await prisma.stockReceipt.findUniqueOrThrow({ where: { id: res.body.data.receipt.id }, include: { items: true } });
      expect(doc).toMatchObject({ supplierName: "ИП Каримов", totalAmount: total });
      expect(doc.items).toHaveLength(5);
      const moves = await prisma.inventoryMovement.findMany({ where: { referenceId: doc.id } });
      expect(moves).toHaveLength(5);
    });
  });

  it("creates weighed goods and goods with an SKU, and prices goods without a price by the category markup", async () => {
    await prisma.category.create({ data: { tenantId: testTenantId, name: "Бакалея", markupPercent: 25 } });
    const res = await importReceipt(
      [
        { row: 2, name: "Рис девзира", category: "бакалея", unit: "кг", stock: "1,5", costPrice: "20 000" },
        { row: 3, name: "Сахар 1 кг", sku: "SG-1", barcode: "4780044444444", stock: 10, costPrice: 12000, price: 15000 },
      ],
      true
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.items[0]).toMatchObject({ kind: "new", salePrice: 25000, quantity: 1.5, sum: 30000 });

    const rice = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Рис девзира" }, include: { category: true } });
    expect(rice).toMatchObject({ unit: "kg", saleUnit: "кг", currentStock: 1.5, costPrice: 20000, price: 25000 });
    expect(rice.category?.name).toBe("Бакалея");
    const sugar = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Сахар 1 кг" } });
    expect(sugar).toMatchObject({ sku: "SG-1", barcode: "4780044444444", unit: "piece", price: 15000, currentStock: 10 });
  });

  it("puts a product taken off sale back on sale when it comes in again, and says so beforehand", async () => {
    const make = (data: Record<string, unknown>) =>
      prisma.product.create({ data: { tenantId: testTenantId, trackInventory: true, currentStock: 0, ...data } as any }).then((p) => p.id);
    // Удалён, но с продажами в истории — значит, только снят с продажи.
    const juice = await make({ name: "Сочная долина 450 мл", price: 3000, costPrice: 2000, isActive: false });
    // По штрихкоду узнаётся архивный, даже если есть активный тёзка без штрихкода.
    const tarhun = await make({ name: "Тархун 0,5 л", barcode: "4780066666666", price: 5000, costPrice: 3500, isActive: false });
    const twin = await make({ name: "Тархун 0,5 л", price: 5000, costPrice: 3500 });
    const rows = [
      { row: 2, name: "Сочная долина 450 мл", stock: 12, costPrice: 2600, price: 3500 },
      { row: 3, name: "Тархун", barcode: "4780066666666", stock: 6, costPrice: 4000 },
    ];

    const check = await importReceipt(rows, false);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.data.summary).toMatchObject({ existing: 2, new: 0, error: 0 });
    expect(check.body.data.items).toEqual([
      expect.objectContaining({ row: 2, kind: "existing", productId: juice, message: "снят с продажи — вернётся в продажу" }),
      expect.objectContaining({ row: 3, kind: "existing", productId: tarhun, message: "снят с продажи — вернётся в продажу" }),
    ]);
    expect(await product(juice)).toMatchObject({ isActive: false, currentStock: 0 });

    const res = await importReceipt(rows, true);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await product(juice)).toMatchObject({ isActive: true, currentStock: 12, costPrice: 2600, price: 3500 });
    expect(await product(tarhun)).toMatchObject({ isActive: true, currentStock: 6, costPrice: 4000, price: 5000 });
    expect(await product(twin)).toMatchObject({ isActive: true, currentStock: 0, costPrice: 3500 });
  });

  it("never puts a new product among the recipe ingredients, even with the same category name", async () => {
    const ingredients = await prisma.category.create({ data: { tenantId: testTenantId, name: "Молочные", isIngredient: true, markupPercent: 0 } });
    await prisma.tenant.update({ where: { id: testTenantId }, data: { defaultMarkupPercent: 30 } });
    try {
      const rows = [{ row: 2, name: "Молоко 1 л", category: "Молочные", stock: 10, costPrice: 10000 }];
      const check = await importReceipt(rows, false);
      expect(check.body.data.items[0]).toMatchObject({ kind: "new", salePrice: 13000 });

      const res = await importReceipt(rows, true);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const milk = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Молоко 1 л" }, include: { category: true } });
      // Цена — та, что показала проверка (наценка заведения), а не по наценке ингредиентов.
      expect(milk).toMatchObject({ price: 13000, currentStock: 10 });
      expect(milk.categoryId).not.toBe(ingredients.id);
      expect(milk.category).toMatchObject({ name: "Молочные", isIngredient: false, markupPercent: 30 });
    } finally {
      await prisma.tenant.update({ where: { id: testTenantId }, data: { defaultMarkupPercent: 0 } });
    }
  });

  it("refuses numbers too big to be a delivery, with the row number", async () => {
    const rows = [
      { row: 2, name: "A", stock: "9".repeat(400), costPrice: 1, price: 2 },
      { row: 3, name: "B", stock: 1e308, costPrice: 1, price: 2 },
      { row: 4, name: "C", stock: 1, costPrice: 1e13, price: 2 },
      { row: 5, name: "D", stock: 1, costPrice: 1, price: "1".repeat(20) },
      { row: 6, name: "E", stock: 1_000_000, costPrice: 1e12, price: 1e12 },
    ];
    const res = await importReceipt(rows, false);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const message = (row: number) => res.body.data.items.find((i: any) => i.row === row).message;
    expect(message(2)).toBe(`количество «${"9".repeat(400)}» — не число`);
    expect(message(3)).toBe("количество «1e+308» — слишком большое число");
    expect(message(4)).toBe("себестоимость «10000000000000» — слишком большое число");
    expect(message(5)).toBe("цена продажи «11111111111111111111» — слишком большое число");
    // Ровно на пределе — ещё поставка, и суммы — конечные числа.
    expect(res.body.data.summary).toEqual({ existing: 0, new: 1, error: 4, quantity: 1_000_000, totalCost: 1e18, totalSale: 1e18 });

    const apply = await importReceipt(rows, true);
    expect(apply.status).toBe(400);
    expect(await prisma.product.count({ where: { tenantId: testTenantId, name: { in: ["A", "B", "C", "D", "E"] } } })).toBe(0);
  });

  it("books two thousand lines in one receipt, and takes them back off when it is deleted", { timeout: 120_000 }, async () => {
    const codes = Array.from({ length: 2000 }, (_, i) => `47801${String(i).padStart(8, "0")}`);
    await prisma.product.createMany({
      data: codes.map((barcode, i) => ({ tenantId: testTenantId, name: `Товар партии ${i}`, barcode, price: 2000, costPrice: 1000, currentStock: 1, trackInventory: true })),
    });
    const rows = codes.map((barcode, i) => ({ row: i + 2, name: `Товар партии ${i}`, barcode, stock: 3, costPrice: 1100, price: i % 2 ? 2500 : undefined }));

    const res = await importReceipt(rows, true);
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(201);
    expect(res.body.data.summary).toMatchObject({ existing: 2000, new: 0, error: 0, quantity: 6000, totalCost: 6000 * 1100 });

    const after = await prisma.product.findMany({ where: { tenantId: testTenantId, barcode: { in: codes } }, orderBy: { name: "asc" } });
    expect(after).toHaveLength(2000);
    for (const p of after) {
      const i = Number(p.name.replace("Товар партии ", ""));
      expect(p).toMatchObject({ currentStock: 4, costPrice: 1100, price: i % 2 ? 2500 : 2000 });
    }
    expect(await prisma.inventoryMovement.count({ where: { referenceId: res.body.data.receipt.id, type: "in" } })).toBe(2000);

    const removed = await call("DELETE", `/stock-receipts/${res.body.data.receipt.id}`, admin);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const back = await prisma.product.findMany({ where: { tenantId: testTenantId, barcode: { in: codes } }, select: { currentStock: true } });
    expect(new Set(back.map((p) => p.currentStock))).toEqual(new Set([1]));
    expect(await prisma.inventoryMovement.count({ where: { referenceId: res.body.data.receipt.id, type: "out" } })).toBe(2000);
  });

  it("never matches another shop's goods", async () => {
    const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-receipt-import", email: "ri@x.uz" } });
    const theirs = await prisma.product.create({ data: { tenantId: other.id, name: "Чужая вода", barcode: "4780099999917", price: 1, currentStock: 1 } });
    const res = await importReceipt([{ row: 2, name: "Вода 1 л", barcode: "4780099999917", stock: 6, costPrice: 2000, price: 3000 }], true);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.summary).toMatchObject({ new: 1, existing: 0 });
    expect(await product(theirs.id)).toMatchObject({ currentStock: 1, price: 1 });
  });

  it("books a resent file once: the same Idempotency-Key answers with the same receipt", async () => {
    const tea = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Чай Ahmad 100 г" } });
    const rows = [
      { row: 2, name: "Чай", barcode: "054881005500", stock: 2, costPrice: 13000, price: 17000 },
      { row: 3, name: "Компот 1 л", barcode: "4780055555555", stock: 4, costPrice: 9000, price: 12000 },
    ];
    const headers = { "Idempotency-Key": "receipt-import-0001" };
    const before = await receipts();

    const first = await importReceipt(rows, true, {}, admin, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await importReceipt(rows, true, {}, admin, headers);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");

    expect(again.body.data.receipt).toEqual(first.body.data.receipt);
    expect(again.body.data.summary).toEqual(first.body.data.summary);
    expect(again.body.data.items.map((i: any) => [i.row, i.kind, i.quantity, i.sum])).toEqual(first.body.data.items.map((i: any) => [i.row, i.kind, i.quantity, i.sum]));
    expect(first.body.data.summary).toMatchObject({ existing: 1, new: 1 });

    expect(await receipts()).toBe(before + 1);
    expect((await product(tea.id)).currentStock).toBe(24);
    expect(await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Компот 1 л" } })).toMatchObject({ currentStock: 4 });

    // Тот же ключ с другим файлом — ошибка клиента, а не повтор.
    const other = await importReceipt([{ ...rows[0], stock: 3 }], true, {}, admin, headers);
    expect(other.status).toBe(422);
  });

  it("answers a resent file as the first time, even when the receipt created a namesake", async () => {
    const cola = await prisma.product.create({ data: { tenantId: testTenantId, name: "Cola", price: 7000, costPrice: 5000, currentStock: 3, trackInventory: true } });
    // Строка 2 — знакомая «Cola» по названию, строка 3 — новая «Cola» со своим штрихкодом.
    const rows = [
      { row: 2, name: "Cola", stock: 2, costPrice: 5500 },
      { row: 3, name: "Cola", barcode: "4780077777777", stock: 4, costPrice: 6000, price: 8000 },
    ];
    const headers = { "Idempotency-Key": "receipt-import-0002" };

    const first = await importReceipt(rows, true, {}, admin, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.summary).toMatchObject({ existing: 1, new: 1, error: 0 });
    // Теперь «Cola» без кодов в базе две — но повтор отвечает тем же, что первый ответ.
    const again = await importReceipt(rows, true, {}, admin, headers);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body.data.summary).toEqual(first.body.data.summary);
    const view = (items: any[]) => items.map((i) => [i.row, i.kind, i.productId ?? null, i.quantity, i.sum, i.message ?? null]);
    expect(view(again.body.data.items)).toEqual(view(first.body.data.items));
    expect(again.body.data.receipt).toEqual(first.body.data.receipt);
    expect((await product(cola.id)).currentStock).toBe(5);
  });

  it("is for the admin and the manager only", async () => {
    const rows = [{ row: 2, name: "X", stock: 1, costPrice: 1, price: 2 }];
    expect((await importReceipt(rows, false, {}, cashier)).status).toBe(403);
    expect((await importReceipt(rows, true, {}, cashier)).status).toBe(403);
    expect(await prisma.product.count({ where: { tenantId: testTenantId, name: "X" } })).toBe(0);
  });
});
