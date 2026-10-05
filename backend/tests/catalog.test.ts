import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import bcrypt from "bcryptjs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";
import { importSnapshot } from "../src/modules/catalog/catalog.import.js";
import { isCatalogBarcode, isValidGtin } from "../src/modules/catalog/gtin.js";
import { toTasnifProduct } from "../src/modules/catalog/catalog.tasnif.js";
import { displayName } from "../src/modules/catalog/names.js";

const OFF_BASE = `http://127.0.0.1:${process.env.TEST_OFF_PORT || 3199}`;

// Codes are spelled with their real check digit — the catalogue refuses the rest.
const SNAPSHOT_CODE = "4780069000154"; // seeded into the catalogue below
const UPC_A = "012345678905"; // 12 digits; the catalogue holds it as 13
const LIVE_HIT = "4607000000014"; // the stubbed Open Food Facts knows it
const LIVE_MISS = "4601000000012"; // nobody knows it
const ADD_A = "4601000000029";
const ADD_WEIGHED = "4785555000014";
const ADD_PRIVATE = "4602000000019";
const withCheck = (prefix12: string) => {
  const sum = prefix12
    .split("")
    .reverse()
    .reduce((acc, digit, index) => acc + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return prefix12 + ((10 - (sum % 10)) % 10);
};
const UZ_NEW = "4780000000014"; // only the national catalogue of Uzbekistan describes it
const UZ_JUNK = "4780000000021"; // the shipped snapshot calls it "viking"; the national catalogue knows better
const UZ_BROWSER = "4780000000038"; // described only by a record the shop's browser brings
const UZ_JUNK2 = "4780000000045"; // a junk snapshot record, corrected by the browser's record
const UZ_CROWD = "4780000000052"; // a shop's own word for an Uzbek code
const NO_SHELF = "4607000000021"; // in the catalogue without a shelf — the name has to say which
const CUSTOM_SHELF = withCheck("460300000003");
const IN_STORE_LABEL = withCheck("210010082891"); // GS1 200–299: a shop's own label

let adminToken: string;
let cashierToken: string;

const api = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });

const lookup = async (code: string, token = cashierToken) => ((await (await api(`/catalog/lookup?code=${code}`, token)).json()) as any).data;
const upstreamHits = async (code: string) => ((await (await fetch(`${OFF_BASE}/__hits/${code}`)).json()) as any).hits as number;
const lookupWith = async (code: string, national: unknown, token = cashierToken) =>
  ((await (await api("/catalog/lookup", token, { method: "POST", body: JSON.stringify({ code, national }) })).json()) as any).data;
const cola = (code: string, extra: Record<string, unknown> = {}) => ({
  internationalCode: code,
  mxikCode: "02202002001010009",
  brandName: "COCA-COLA",
  attributeName: "сладкий, ПЭТ бутылка 1,5 л.",
  subPositionName: "Безалкогольные напитки (газированные и негазированные)",
  positionName: "Прохладительные безалкогольные напитки",
  ...extra,
});
const nationalHits = async (code: string) => ((await (await fetch(`${OFF_BASE}/__hits/tasnif/${code}`)).json()) as any).hits as number;
const add = (token: string, body: Record<string, unknown>) => api("/catalog/add", token, { method: "POST", body: JSON.stringify(body) });

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 3000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("Barcode catalogue", () => {
  beforeAll(async () => {
    await setupTestData();
    const tokens = await getTokens(BASE_URL);
    adminToken = tokens.adminToken;
    cashierToken = tokens.cashierToken;
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", defaultMarkupPercent: 20 } });
    await prisma.catalogProduct.createMany({
      data: [
        { barcode: SNAPSHOT_CODE, name: "Coca-Cola Classic", brand: "Coca-Cola", quantity: "1,5 л", category: "Напитки", source: "snapshot" },
        { barcode: "0" + UPC_A, name: "Sparkling water", quantity: "0,5 л", category: "Напитки", source: "snapshot" },
        { barcode: NO_SHELF, name: "Молоко Простоквашино 3,2%", quantity: "930 мл", source: "snapshot" },
        { barcode: UZ_JUNK, name: "viking", source: "snapshot" },
        { barcode: UZ_JUNK2, name: "ooo", source: "snapshot" },
        { barcode: UZ_CROWD, name: "Мой кефир", source: "crowd" },
      ],
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  // ── проверка штрихкода ───────────────────────────────────────────────────

  it("knows a real product code from a mistyped one and from a shop's own label", () => {
    expect(isValidGtin(SNAPSHOT_CODE)).toBe(true);
    expect(isValidGtin("4780069000155")).toBe(false); // wrong check digit
    expect(isValidGtin("104")).toBe(false); // a keypad short code
    expect(isCatalogBarcode(IN_STORE_LABEL)).toBe(false); // valid digits, but private to one shop
  });

  // ── поиск ────────────────────────────────────────────────────────────────

  it("needs a signed-in user", async () => {
    expect((await api(`/catalog/lookup?code=${SNAPSHOT_CODE}`, null)).status).toBe(401);
  });

  it("answers from the shipped catalogue with a ready product name", async () => {
    const hit = await lookup(SNAPSHOT_CODE);
    expect(hit).toMatchObject({ found: true, barcode: SNAPSHOT_CODE, name: "Coca-Cola Classic", brand: "Coca-Cola", quantity: "1,5 л", category: "Напитки", source: "snapshot" });
    expect(hit.displayName).toBe("Coca-Cola Classic 1,5 л"); // brand is in the name already, size is added
  });

  it("suggests a shelf from the name when the record has none", async () => {
    expect(await lookup(NO_SHELF)).toMatchObject({ found: true, category: "Молочные продукты", displayName: "Молоко Простоквашино 3,2% 930 мл" });
  });

  it("finds the same product whether the scanner reads 12 or 13 digits", async () => {
    expect((await lookup(UPC_A)).found).toBe(true);
    expect((await lookup("0" + UPC_A)).found).toBe(true);
  });

  it("does not look up what cannot be a product code", async () => {
    expect(await lookup("4780069000155")).toEqual({ found: false, barcode: "4780069000155", valid: false });
    expect((await lookup(IN_STORE_LABEL)).valid).toBe(false);
    expect((await lookup("104")).valid).toBe(false);
    expect(await upstreamHits(IN_STORE_LABEL)).toBe(0);
  });

  // ── живой поиск ──────────────────────────────────────────────────────────

  it("asks Open Food Facts once for a code it does not have, and remembers the answer", async () => {
    const first = await lookup(LIVE_HIT);
    expect(first).toMatchObject({ found: true, source: "off", name: "Choco & Nuts", brand: "Acme", quantity: "250 г", category: "Сладости" });
    expect(first.displayName).toBe("Acme Choco & Nuts 250 г");

    const again = await lookup(LIVE_HIT);
    expect(again.found).toBe(true);
    expect(await upstreamHits(LIVE_HIT)).toBe(1);
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: LIVE_HIT } })).toMatchObject({ source: "off", name: "Choco & Nuts" });
  });

  it("does not ask again about a code nobody knows", async () => {
    expect(await lookup(LIVE_MISS)).toEqual({ found: false, barcode: LIVE_MISS, valid: true });
    expect((await lookup(LIVE_MISS)).found).toBe(false);
    expect(await upstreamHits(LIVE_MISS)).toBe(1);
  });

  // ── национальный каталог Узбекистана ─────────────────────────────────────

  it("takes a code nobody else describes from the national catalogue of Uzbekistan, with its IKPU", async () => {
    const hit = await lookup(UZ_NEW);
    expect(hit).toMatchObject({
      found: true,
      source: "tasnif",
      name: "Pure-Milk сметана жирность 20%",
      brand: "Pure-Milk",
      quantity: "180 г",
      category: "Молочные продукты",
      ikpu: "00403999008070006",
      displayName: "Pure-Milk сметана жирность 20% 180 г",
    });
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: UZ_NEW } })).toMatchObject({ source: "tasnif", ikpu: "00403999008070006" });

    await lookup(UZ_NEW);
    expect(await nationalHits(UZ_NEW)).toBe(1); // asked once, remembered
  });

  it("replaces what volunteers typed about an Uzbek code with the national catalogue's description — once", async () => {
    const hit = await lookup(UZ_JUNK);
    expect(hit).toMatchObject({ source: "tasnif", name: "Пиво Viking Пастеризованное фильтрованное крепость 4,4%", quantity: "0,65 л", category: "Алкоголь", ikpu: "02203001001286001" });
    await lookup(UZ_JUNK);
    expect(await nationalHits(UZ_JUNK)).toBe(1);
  });

  it("leaves an Uzbek snapshot record alone when the national catalogue does not know the code, and does not ask again", async () => {
    expect(await lookup(SNAPSHOT_CODE)).toMatchObject({ source: "snapshot", name: "Coca-Cola Classic", ikpu: null });
    await lookup(SNAPSHOT_CODE);
    expect(await nationalHits(SNAPSHOT_CODE)).toBe(1);
  });

  it("uses Open Food Facts' words for a non-Uzbek code, but still brings the IKPU from the national catalogue", async () => {
    // LIVE_HIT was first looked up in the live tests above: both public catalogues know it, and disagree about the name
    const hit = await lookup(LIVE_HIT);
    expect(hit).toMatchObject({ source: "off", name: "Choco & Nuts", ikpu: "01905012001444068" });
  });

  // The server cannot always reach the national catalogue (Railway is turned away), so the shop's
  // browser asks it and hands the record over.

  it("shows a record the shop's browser fetched from the national catalogue — and does not store it", async () => {
    const hit = await lookupWith(UZ_BROWSER, cola(UZ_BROWSER));
    expect(hit).toMatchObject({ found: true, source: "tasnif", name: "Coca-Cola сладкий", quantity: "1,5 л", category: "Напитки", ikpu: "02202002001010009", displayName: "Coca-Cola сладкий 1,5 л" });
    // the server cannot vouch for it, so other shops never see it as an official record
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: UZ_BROWSER } })).toBeNull();
    expect((await lookup(UZ_BROWSER)).found).toBe(false);
  });

  it("lets the browser's record correct what volunteers typed about an Uzbek code, but not a shop's own word", async () => {
    expect(await lookupWith(UZ_JUNK2, cola(UZ_JUNK2))).toMatchObject({ source: "tasnif", name: "Coca-Cola сладкий" });
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: UZ_JUNK2 } })).toMatchObject({ name: "ooo", source: "snapshot" });

    expect(await lookupWith(UZ_CROWD, cola(UZ_CROWD))).toMatchObject({ source: "crowd", name: "Мой кефир", ikpu: "02202002001010009" });
  });

  it("adds only the IKPU when the code is not Uzbek and the server already has words for it", async () => {
    expect(await lookupWith(NO_SHELF, cola(NO_SHELF))).toMatchObject({ source: "snapshot", name: "Молоко Простоквашино 3,2%", ikpu: "02202002001010009" });
  });

  it("ignores a record that is not about this barcode or carries no real IKPU", async () => {
    const other = UZ_BROWSER.slice(0, 12) + ((Number(UZ_BROWSER[12]) + 1) % 10);
    expect((await lookupWith(UZ_BROWSER, cola(other))).found).toBe(false); // someone else's barcode
    expect((await lookupWith(UZ_BROWSER, cola(UZ_BROWSER, { mxikCode: "123" }))).found).toBe(false); // not a 17-digit IKPU
    expect((await lookupWith(UZ_BROWSER, "just text")).found).toBe(false);
    expect((await lookupWith(UZ_BROWSER, null)).found).toBe(false);
  });

  it("keeps the IKPU with the product the shop adds", async () => {
    const res = await add(adminToken, { barcode: UZ_BROWSER, name: "Coca-Cola сладкий 1,5 л", price: 9500, ikpu: "02202002001010009" });
    expect(JSON.parse(((await res.json()) as any).data.metadata)).toEqual({ ikpu: "02202002001010009" });
    expect((await add(adminToken, { barcode: UZ_JUNK2, name: "x", price: 1, ikpu: "123" })).status).toBe(400);
  });

  describe("records of the national catalogue", () => {
    const record = (brandName: string, attributeName: string, subPositionName: string, mxikCode = "02202002001010009", positionName = "") => ({ mxikCode, brandName, attributeName, subPositionName, positionName });
    const shop = (r: Record<string, string>) => {
      const p = toTasnifProduct(r)!;
      return displayName(p.name, p.quantity, p.brand);
    };

    it("become names a cashier recognises: brand first, pack size last, packaging dropped", () => {
      expect(shop(record("COCA-COLA", "сладкий, ПЭТ бутылка 1,5 л.", "Безалкогольные напитки (газированные и негазированные)"))).toBe("Coca-Cola сладкий 1,5 л");
      expect(shop(record("Сочная долина", "Яблоко Тетра Пак 1 л", "Фруктовые и овощные соки, в т.ч. потока (всех видов)", "02009001006076066"))).toBe("Сочная долина Яблоко 1 л");
      expect(shop(record("Hydrolife", "ПЭТ бутылка 0,5 л", "Негазированная вода", "02201001001011003"))).toBe("Негазированная вода Hydrolife 0,5 л");
      expect(shop(record("FANTA", "Fanta Orange Vitamin C сладкий, ПЭТ бутылка 1,5 л.", "Безалкогольные напитки (газированные и негазированные)"))).toBe("Fanta Orange Vitamin C сладкий 1,5 л"); // the brand is not said twice
      expect(shop(record("Tegen", "Перец стручковый острый с овощами Стеклянная банка твист-офф крышка 720 мл", "Овощи, фрукты, орехи, консервированные", "02001001005017002"))).toBe("Tegen Перец стручковый острый с овощами 720 мл");
    });

    it("name a shelf from the description, not from a flavour or from the wider position", () => {
      expect(toTasnifProduct(record("Mega", "Семечки подсолнуха жаренные полосатые солёные Бумажный пакет 100 г.", "Жареные семечки подсолнечника", "02008001001040020", "Овощи, фрукты, орехи, консервированные или приготовленные"))!.category).toBe("Снеки");
      expect(toTasnifProduct(record("Milliy Cola", "со вкусом Колы пэт бутылка 1,5 л", "Безалкогольные напитки (газированные и негазированные)", "02202002001444002"))!.category).toBe("Напитки");
      expect(toTasnifProduct(record("Surhan", "Белое сухое, Крепость 12%, Стеклянная бутылка 0,75 л", "Вино", "02204001001636002"))!.category).toBe("Алкоголь");
    });

    it("are ignored when they carry no usable IKPU code", () => {
      expect(toTasnifProduct({ mxikCode: "123", brandName: "X", attributeName: "y", subPositionName: "z" })).toBeNull();
    });
  });

  // ── добавление сканером ──────────────────────────────────────────────────

  it("puts a scanned product on the shelf: the catalogue's name, the shop's price, its own shelf", async () => {
    const res = await add(adminToken, { barcode: LIVE_HIT, name: "Acme Choco & Nuts 250 г", price: 18000, categoryName: "Сладости" });
    const body = (await res.json()) as any;

    expect(res.status).toBe(201);
    // Магазин ведёт остаток у каждого товара — и у заведённого без количества.
    expect(body.data).toMatchObject({ name: "Acme Choco & Nuts 250 г", barcode: LIVE_HIT, price: 18000, trackInventory: true, currentStock: 0, saleUnit: null });
    expect(body.data.category).toMatchObject({ name: "Сладости", markupPercent: 20 }); // created, with the shop's default markup
    expect(JSON.parse(body.data.metadata)).toEqual({ ikpu: "01905012001444068" }); // the code the invoice and the receipt need

    // the register now finds it by its barcode, like any product
    const found = await api(`/products/lookup?code=${LIVE_HIT}`, cashierToken);
    expect(((await found.json()) as any).data.price).toBe(18000);
  });

  it("reuses the shop's existing shelf instead of creating a second one", async () => {
    await add(adminToken, { barcode: ADD_A, name: "Печенье", price: 5000, categoryName: "сладости" });
    expect(await prisma.category.count({ where: { tenantId: testTenantId, name: { in: ["Сладости", "сладости"] } } })).toBe(1);
  });

  it("refuses a barcode the shop already has", async () => {
    const res = await add(adminToken, { barcode: LIVE_HIT, name: "Другое", price: 1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("Acme Choco");
  });

  it("recognises the shop's product under either spelling of a UPC-A code", async () => {
    await add(adminToken, { barcode: "0" + UPC_A, name: "Вода газированная 0,5 л", price: 3000 });
    expect((await add(adminToken, { barcode: UPC_A, name: "Вода", price: 3000 })).status).toBe(409);
  });

  it("brings back an archived product instead of refusing it", async () => {
    await prisma.product.updateMany({ where: { tenantId: testTenantId, barcode: LIVE_HIT }, data: { isActive: false } });
    const res = await add(adminToken, { barcode: LIVE_HIT, name: "Ignored — the shop's own name stays", price: 19000 });
    const data = ((await res.json()) as any).data;
    expect(res.status).toBe(201);
    expect(data).toMatchObject({ name: "Acme Choco & Nuts 250 г", price: 19000, isActive: true });
    expect(JSON.parse(data.metadata)).toEqual({ ikpu: "01905012001444068" }); // the IKPU survives the round trip
    expect(await prisma.product.count({ where: { tenantId: testTenantId, barcode: LIVE_HIT } })).toBe(1);
  });

  it("sells by the kilo when asked, with stock in kilograms", async () => {
    const res = await add(adminToken, { barcode: ADD_WEIGHED, name: "Орехи кешью", price: 90000, weighed: true, stock: 12.5 });
    const data = ((await res.json()) as any).data;
    expect(data).toMatchObject({ saleUnit: "кг", unit: "kg", trackInventory: true, currentStock: 12.5, price: 90000 });
  });

  it("lets only an admin or a manager add products", async () => {
    expect((await add(cashierToken, { barcode: ADD_PRIVATE, name: "Чай", price: 1 })).status).toBe(403);
    expect(await prisma.product.count({ where: { tenantId: testTenantId, barcode: ADD_PRIVATE } })).toBe(0);
  });

  it("rejects nonsense", async () => {
    expect((await add(adminToken, { barcode: "abc", name: "x", price: 1 })).status).toBe(400);
    expect((await add(adminToken, { barcode: ADD_PRIVATE, name: "", price: 1 })).status).toBe(400);
    expect((await add(adminToken, { barcode: ADD_PRIVATE, name: "x", price: -5 })).status).toBe(400);
  });

  // ── общая база растёт от магазинов ───────────────────────────────────────

  it("shares what a shop adds — name and shelf, never a price — so the next shop finds it", async () => {
    const row = await waitFor(() => prisma.catalogProduct.findUnique({ where: { barcode: ADD_A } }));
    expect(row).toMatchObject({ name: "Печенье", source: "crowd", confirmations: 1, category: "Сладости" }); // a standard shelf name is shared
    expect(Object.keys(row!)).not.toContain("price");

    // a shop's own category names stay its own
    await add(adminToken, { barcode: CUSTOM_SHELF, name: "Хит недели", price: 100, categoryName: "Мои хиты" });
    expect(await waitFor(() => prisma.catalogProduct.findUnique({ where: { barcode: CUSTOM_SHELF } }))).toMatchObject({ name: "Хит недели", category: null });

    const seen = await lookup(ADD_A);
    expect(seen).toMatchObject({ found: true, source: "crowd", name: "Печенье" });
  });

  it("counts a second shop typing the same name as a confirmation, and never overwrites the snapshot", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Second Shop", slug: "second-shop", businessType: "retail" } });
    await prisma.user.create({ data: { tenantId: tenant.id, email: "admin2@test.com", passwordHash: await bcrypt.hash("admin123", 12), firstName: "A", lastName: "Two", role: "admin" } });
    const login = await api("/auth/login", null, { method: "POST", body: JSON.stringify({ email: "admin2@test.com", password: "admin123" }) });
    const token2 = ((await login.json()) as any).data.accessToken as string;

    expect((await add(token2, { barcode: ADD_A, name: "печенье", price: 4000 })).status).toBe(201);
    expect(await waitFor(async () => ((await prisma.catalogProduct.findUnique({ where: { barcode: ADD_A } }))!.confirmations >= 2 ? true : null))).toBe(true);

    // a different name for a code the snapshot already knows changes nothing
    expect((await add(token2, { barcode: SNAPSHOT_CODE, name: "Кола", price: 9000 })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: SNAPSHOT_CODE } })).toMatchObject({ name: "Coca-Cola Classic", source: "snapshot" });
  });

  it("shares nothing when the shop has opted out, and nothing that is not a real product code", async () => {
    await prisma.tenant.update({ where: { id: testTenantId }, data: { catalogSharing: false } });
    await add(adminToken, { barcode: ADD_PRIVATE, name: "Секретный товар", price: 100 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: ADD_PRIVATE } })).toBeNull();

    await prisma.tenant.update({ where: { id: testTenantId }, data: { catalogSharing: true } });
    await add(adminToken, { barcode: IN_STORE_LABEL, name: "Набор для окрошки", price: 100 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.catalogProduct.findUnique({ where: { barcode: IN_STORE_LABEL } })).toBeNull();
  });

  it("learns from a product entered by hand in the admin panel too", async () => {
    const code = withCheck("478111100002");
    const res = await api("/products", adminToken, { method: "POST", body: JSON.stringify({ name: "Халва ореховая", price: 7000, barcode: code }) });
    expect(res.status).toBe(201);
    expect(await waitFor(() => prisma.catalogProduct.findUnique({ where: { barcode: code } }))).toMatchObject({ name: "Халва ореховая", source: "crowd" });
  });

  it("reports how much the shared base holds", async () => {
    const res = await api("/catalog/stats", adminToken);
    const data = ((await res.json()) as any).data;
    expect(data.total).toBeGreaterThanOrEqual(4);
    expect(data.crowd).toBeGreaterThanOrEqual(1);
  });

  // ── поставка каталога ────────────────────────────────────────────────────

  describe("shipped snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const write = (name: string, rows: object[]) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, zlib.gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
      return file;
    };
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("loads into the database once, and leaves what shops added alone when refreshed", async () => {
      const upc = "036000291452"; // a UPC-A code (valid): stored with the leading zero
      const first = write("v1.jsonl.gz", [
        { b: "5449000000996", n: "Coca-Cola", br: "Coca-Cola", q: "0,33 л", c: "Напитки" },
        { b: upc, n: "Old name" },
        { b: ADD_A, n: "Snapshot must not replace the shop's word" },
        { b: "bad", n: "Not a barcode" },
        { b: "5449000000996", n: "Duplicate line in the same file", br: "Coca-Cola" },
      ]);

      const run1 = await importSnapshot(first);
      expect(run1.skipped).toBe(false);
      expect(await prisma.catalogProduct.findUnique({ where: { barcode: "0" + upc } })).toMatchObject({ name: "Old name", source: "snapshot" });
      expect(await prisma.catalogProduct.findUnique({ where: { barcode: "5449000000996" } })).toMatchObject({ source: "snapshot" });
      expect(await prisma.catalogProduct.findUnique({ where: { barcode: ADD_A } })).toMatchObject({ name: "Печенье", source: "crowd" });
      expect(await prisma.catalogProduct.findUnique({ where: { barcode: "bad" } })).toBeNull();

      expect((await importSnapshot(first)).skipped).toBe(true); // same file: nothing to do

      const second = write("v2.jsonl.gz", [{ b: upc, n: "New name", br: "Acme", q: "500 г", c: "Бакалея" }]);
      expect((await importSnapshot(second)).skipped).toBe(false);
      expect(await prisma.catalogProduct.findUnique({ where: { barcode: "0" + upc } })).toMatchObject({ name: "New name", brand: "Acme", quantity: "500 г", category: "Бакалея" });
    });

    it("starts without a snapshot rather than failing", async () => {
      expect(await importSnapshot(path.join(dir, "missing.jsonl.gz"))).toEqual({ skipped: true, rows: 0 });
    });
  });
});
