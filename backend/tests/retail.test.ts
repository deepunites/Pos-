import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

let adminToken: string;
let cashierToken: string;

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });

const checkout = (token: string, items: any[], expectedTotal: number, method = "cash") =>
  api("/orders/checkout", token, {
    method: "POST",
    body: JSON.stringify({ type: "takeaway", items, expectedTotal, payment: { method } }),
  });

async function product(data: Record<string, unknown>) {
  return prisma.product.create({ data: { tenantId: testTenantId, trackInventory: true, ...data } as any });
}

describe("Retail: weighted goods, lookup, search, business type", () => {
  beforeAll(async () => {
    await setupTestData();
    const tokens = await getTokens(BASE_URL);
    adminToken = tokens.adminToken;
    cashierToken = tokens.cashierToken;
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS" } });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  // ── вес ──────────────────────────────────────────────────────────────────

  it("prices a product sold per kilogram from the weight in grams and takes kilograms out of stock", async () => {
    const apples = await product({ name: "Яблоки", price: 18000, currentStock: 84.2, saleUnit: "кг", sku: "104" });

    const res = await checkout(cashierToken, [{ productId: apples.id, quantity: 1, grams: 1240 }], 22320);
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.total).toBe(22320);
    expect(body.data.items[0].weightGrams).toBe(1240);
    expect(body.data.items[0].totalPrice).toBe(22320);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: apples.id } });
    expect(after.currentStock).toBeCloseTo(84.2 - 1.24, 5);
  });

  it("keeps pricing gram-priced products per gram, and counts every portion against stock", async () => {
    // Раньше со склада списывался один вес, сколько бы порций ни продали.
    const tea = await product({ name: "Чай на развес", price: 18, currentStock: 5000, saleUnit: "г" });

    const res = await checkout(cashierToken, [{ productId: tea.id, quantity: 2, grams: 100 }], 3600);
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(body.data.total).toBe(3600);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: tea.id } });
    expect(after.currentStock).toBe(4800);
  });

  it("counts stock to the gram: no float noise, and the last bit can always be sold", async () => {
    // 0.3 − 0.1 = 0.19999999999999998 in plain arithmetic, which is < 0.2:
    // the second sale would be refused although 200 g are on the shelf.
    const nuts = await product({ name: "Орехи", price: 100000, currentStock: 0.3, saleUnit: "кг" });

    expect((await checkout(cashierToken, [{ productId: nuts.id, quantity: 1, grams: 100 }], 10000)).status).toBe(201);
    expect((await checkout(cashierToken, [{ productId: nuts.id, quantity: 1, grams: 200 }], 20000)).status).toBe(201);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: nuts.id } })).currentStock).toBe(0);

    // and the everyday case: 84.2 − 1.24 is stored as 82.96, not 82.96000000000001
    const apples = await product({ name: "Груши", price: 18000, currentStock: 84.2, saleUnit: "кг" });
    await checkout(cashierToken, [{ productId: apples.id, quantity: 1, grams: 1240 }], 22320);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: apples.id } })).currentStock).toBe(82.96);
  });

  it("keeps stock clean when goods are received and a receipt is cancelled", async () => {
    // 82.96 + 10.55 is 93.50999999999999 in plain arithmetic.
    const plums = await product({ name: "Сливы", price: 20000, currentStock: 82.96, saleUnit: "кг" });

    const created = await api("/stock-receipts", cashierToken, {
      method: "POST",
      body: JSON.stringify({ supplierName: "Поставщик", items: [{ productId: plums.id, quantity: 10.55, costPrice: 14000 }] }),
    });
    expect(created.status).toBe(201);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: plums.id } })).currentStock).toBe(93.51);

    const receiptId = ((await created.json()) as any).data.id;
    const removed = await api(`/stock-receipts/${receiptId}`, adminToken, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: plums.id } })).currentStock).toBe(82.96);
  });

  it("refuses a weighed product sold without a weight", async () => {
    const cheese = await product({ name: "Сыр", price: 92000, currentStock: 6.8, saleUnit: "кг" });
    const res = await checkout(cashierToken, [{ productId: cheese.id, quantity: 1 }], 92000);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("не указан вес");
  });

  it("sells a weighed product below zero in a shop, and names the unit when a café runs short", async () => {
    const lemons = await product({ name: "Лимоны", price: 28000, currentStock: 0.5, saleUnit: "кг" });
    // Магазин: товар на полке, приход не внесён — продажа проходит, остаток уходит в минус.
    expect((await checkout(cashierToken, [{ productId: lemons.id, quantity: 1, grams: 1000 }], 28000)).status).toBe(201);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: lemons.id } })).currentStock).toBeCloseTo(-0.5, 5);

    // Кафе: как раньше — не хватает, значит отказ, с единицей измерения.
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "cafe" } });
    try {
      await prisma.product.update({ where: { id: lemons.id }, data: { currentStock: 0.5, trackInventory: true } });
      const res = await checkout(cashierToken, [{ productId: lemons.id, quantity: 1, grams: 1000 }], 28000);
      const body = (await res.json()) as any;
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body.error).toContain("осталось 0.5 кг");
    } finally {
      await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail" } });
    }
  });

  it("returns kilograms to stock when an order for a weighed product is cancelled", async () => {
    const carrots = await product({ name: "Морковь", price: 5000, currentStock: 10, saleUnit: "кг" });

    const created = await api("/orders", adminToken, {
      method: "POST",
      body: JSON.stringify({ type: "takeaway", items: [{ productId: carrots.id, quantity: 1, grams: 2500 }] }),
    });
    const order = ((await created.json()) as any).data;
    expect((await prisma.product.findUniqueOrThrow({ where: { id: carrots.id } })).currentStock).toBeCloseTo(7.5, 5);

    const cancelled = await api(`/orders/${order.id}/cancel`, adminToken, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: carrots.id } })).currentStock).toBeCloseTo(10, 5);
  });

  // ── поиск по коду ───────────────────────────────────────────────────────

  describe("lookup", () => {
    beforeAll(async () => {
      await product({ name: "Молоко «Лактис» 3,2% 1 л", price: 13500, currentStock: 40, barcode: "4780000000119", sku: "M32" });
      await product({ name: "Пакет фасовочный", price: 500, currentStock: 900, sku: "P01" });
      await product({ name: "Двойник", price: 1, currentStock: 1, sku: "4780000000119" }); // SKU равен чужому штрихкоду
      await product({ name: "Архивный", price: 1, currentStock: 1, barcode: "1111111111116", isActive: false });
      await product({ name: "Мука (сырьё)", price: 1, currentStock: 1, barcode: "2222222222220", isIngredient: true });
    });

    const lookup = (code: string, token = cashierToken) => api(`/products/lookup?code=${encodeURIComponent(code)}`, token);

    it("finds a product by its barcode", async () => {
      const res = await lookup("4780000000119");
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Молоко «Лактис» 3,2% 1 л");
    });

    it("finds the same product whether the scanner reads 12 digits (UPC-A) or 13 (EAN-13 with a leading zero)", async () => {
      await product({ name: "Импортный шоколад", price: 20000, currentStock: 5, barcode: "0012345678905" });
      await product({ name: "Импортное печенье", price: 10000, currentStock: 5, barcode: "876543210987" });

      // stored as EAN-13 with a zero, scanned as UPC-A
      expect(((await (await lookup("012345678905")).json()) as any).data.name).toBe("Импортный шоколад");
      // stored as UPC-A, scanned as EAN-13 with a zero
      expect(((await (await lookup("0876543210987")).json()) as any).data.name).toBe("Импортное печенье");
      // and the exact form still works
      expect(((await (await lookup("0012345678905")).json()) as any).data.name).toBe("Импортный шоколад");
    });

    it("finds a product by its short code", async () => {
      const res = await lookup("P01");
      expect(((await res.json()) as any).data.name).toBe("Пакет фасовочный");
    });

    it("lets a real barcode win over an SKU that happens to look the same", async () => {
      const body = (await (await lookup("4780000000119")).json()) as any;
      expect(body.data.name).not.toBe("Двойник");
    });

    it("does not sell archived goods or ingredients", async () => {
      expect((await lookup("1111111111116")).status).toBe(404);
      expect((await lookup("2222222222220")).status).toBe(404);
    });

    it("answers 404 for an unknown code and 400 for an empty one", async () => {
      expect((await lookup("0000000000000")).status).toBe(404);
      expect((await api("/products/lookup?code=", cashierToken)).status).toBe(400);
    });

    it("never returns another shop's product", async () => {
      const other = await prisma.tenant.create({ data: { name: "Чужой", slug: "chuzhoy" } });
      await prisma.product.create({ data: { tenantId: other.id, name: "Чужой товар", price: 1, barcode: "9999999999994" } });
      expect((await lookup("9999999999994")).status).toBe(404);
    });
  });

  // ── поиск по названию ───────────────────────────────────────────────────

  describe("search", () => {
    beforeAll(async () => {
      await product({ name: "Кока-Кола 1,5 л", price: 14500, currentStock: 90, barcode: "5449000000996" });
      await product({ name: "ФАНТА апельсин", price: 14500, currentStock: 40 });
      await product({ name: "Хлеб «Нон» белый", price: 4500, currentStock: 80, tags: JSON.stringify(["quick"]) });
    });

    const names = async (query: string) => {
      const res = await api(`/products?limit=100&${query}`, cashierToken);
      return ((await res.json()) as any).data.map((p: any) => p.name) as string[];
    };

    it("finds Cyrillic names whatever case the cashier types", async () => {
      expect(await names("search=молоко")).toContain("Молоко «Лактис» 3,2% 1 л");
      expect(await names("search=МОЛОКО")).toContain("Молоко «Лактис» 3,2% 1 л");
      expect(await names("search=фанта")).toContain("ФАНТА апельсин");
      expect(await names("search=кола")).toContain("Кока-Кола 1,5 л");
    });

    it("matches every word, in any order", async () => {
      expect(await names("search=" + encodeURIComponent("лактис молоко"))).toContain("Молоко «Лактис» 3,2% 1 л");
      expect(await names("search=" + encodeURIComponent("лактис хлеб"))).toEqual([]);
    });

    it("still searches barcodes and short codes", async () => {
      expect(await names("search=5449000000")).toContain("Кока-Кола 1,5 л");
      expect(await names("search=M32")).toContain("Молоко «Лактис» 3,2% 1 л");
    });

    // На SQLite LIKE не различал регистр латиницы сам по себе, а кириллицу
    // выручали варианты написания (utils/search.ts). В Postgres LIKE
    // чувствителен к регистру целиком — без ILIKE артикул, набранный
    // строчными, перестал бы находиться.
    it("ignores case in short codes and in any mix of letters", async () => {
      expect(await names("search=m32")).toContain("Молоко «Лактис» 3,2% 1 л");
      expect(await names("search=" + encodeURIComponent("фАнТа"))).toContain("ФАНТА апельсин");
      expect(await names("search=" + encodeURIComponent("кока-кола"))).toContain("Кока-Кола 1,5 л");
    });

    it("filters weighed goods and tagged goods", async () => {
      const weighed = await names("weighted=true");
      expect(weighed).toEqual(expect.arrayContaining(["Яблоки", "Сыр", "Чай на развес"]));
      expect(weighed).not.toContain("Пакет фасовочный");

      const notWeighed = await names("weighted=false");
      expect(notWeighed).toContain("Пакет фасовочный");
      expect(notWeighed).not.toContain("Яблоки");

      expect(await names("tag=quick")).toEqual(["Хлеб «Нон» белый"]);
    });
  });

  // ── тип заведения ───────────────────────────────────────────────────────

  describe("business type", () => {
    it("is not changed from the settings: it is chosen at registration only", async () => {
      // Старые открытые админки ещё присылают businessType при каждом
      // сохранении «Общих» — сохранение проходит, тип остаётся прежним.
      const res = await api("/settings", adminToken, { method: "PUT", body: JSON.stringify({ businessType: "cafe", currency: "UZS" }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data.businessType).toBe("retail");
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: testTenantId } })).businessType).toBe("retail");
    });

    it("is chosen at registration, and the shop code is a readable transliteration", async () => {
      const register = (email: string, businessType?: string) =>
        fetch(`${BASE_URL}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email, password: "password123", firstName: "Дильшод", lastName: "Каримов",
            tenantName: "Продукты «Барака»", ...(businessType ? { businessType } : {}),
          }),
        });

      const first = await register("first@baraka.uz", "retail");
      expect(first.status).toBe(201);
      const second = await register("second@baraka.uz");
      expect(second.status).toBe(201);

      const shops = await prisma.tenant.findMany({ where: { name: "Продукты «Барака»" }, orderBy: { createdAt: "asc" } });
      expect(shops.map((t) => t.slug)).toEqual(["produkty-baraka", "produkty-baraka-2"]);
      expect(shops.map((t) => t.businessType)).toEqual(["retail", "cafe"]);
    });
  });

  // ── чек ─────────────────────────────────────────────────────────────────

  describe("printed receipt", () => {
    it("shows the shop's currency, the weight and the real payment method", async () => {
      const grapes = await product({ name: "Виноград", price: 32000, currentStock: 12, saleUnit: "кг" });
      const bag = await product({ name: "Пакет", price: 500, currentStock: 100 });

      const sale = await checkout(
        cashierToken,
        [{ productId: grapes.id, quantity: 1, grams: 750 }, { productId: bag.id, quantity: 2 }],
        25000,
        "qr"
      );
      const order = ((await sale.json()) as any).data;
      expect(order.total).toBe(25000);

      const receipt = await (await api(`/receipts/${order.id}`, cashierToken)).text();
      expect(receipt).toContain("0,750 кг");
      expect(receipt).toContain("сўм");
      expect(receipt).toContain("QR");
      expect(receipt).toContain("Кассир");
      expect(receipt).not.toContain("₽");
      expect(receipt).not.toContain("Официант");
      expect(receipt).not.toContain("В зале");
    });
  });
});
