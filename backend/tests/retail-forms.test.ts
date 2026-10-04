import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";

// Формы магазина: номер накладной ставится сам, новый товар в приходе — без
// категории, со штрихкодом и на вес; подсказка «последняя поставка».

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

const receipt = (token: string, items: unknown[], extra: Record<string, unknown> = {}) => call("POST", "/stock-receipts", token, { items, ...extra });

describe("Retail forms", () => {
  let juice: string;

  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS" } });
    juice = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Сок", price: 14000, trackInventory: true } })).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("invoice number", () => {
    it("is given in order when left empty, and shown before the receipt is made", async () => {
      expect((await call("GET", "/stock-receipts/next-number", cashier)).body.data.invoiceNumber).toBe("ПР-0001");
      const first = await receipt(admin, [{ productId: juice, quantity: 10, costPrice: 11000 }]);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.data.invoiceNumber).toBe("ПР-0001");
      const second = await receipt(admin, [{ productId: juice, quantity: 5, costPrice: 11500 }], { invoiceNumber: "  " });
      expect(second.body.data.invoiceNumber).toBe("ПР-0002");
      expect((await call("GET", "/stock-receipts/next-number", admin)).body.data.invoiceNumber).toBe("ПР-0003");
    });

    it("keeps the supplier's own number and does not count it", async () => {
      const own = await receipt(admin, [{ productId: juice, quantity: 1, costPrice: 11500 }], { invoiceNumber: "НК-1042" });
      expect(own.body.data.invoiceNumber).toBe("НК-1042");
      expect((await call("GET", "/stock-receipts/next-number", admin)).body.data.invoiceNumber).toBe("ПР-0003");
    });
  });

  describe("new product in a receipt", () => {
    it("needs no category in a shop and keeps its barcode", async () => {
      const res = await receipt(cashier, [{ newProduct: { name: "Чай Ahmad 100 г", barcode: "054881005500" }, quantity: 12, costPrice: 21000, salePrice: 26000 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const tea = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Чай Ahmad 100 г" } });
      expect(tea).toMatchObject({ categoryId: null, barcode: "054881005500", currentStock: 12, price: 26000, saleUnit: null });
    });

    it("is sold by weight when it came in kilograms", async () => {
      const res = await receipt(cashier, [
        { newProduct: { name: "Сахар", weighed: true }, quantity: 50, costPrice: 11000, salePrice: 13000 },
        { newProduct: { name: "Рис", unit: "кг" }, quantity: 25, costPrice: 15000, salePrice: 18000 },
      ]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      for (const name of ["Сахар", "Рис"]) {
        expect(await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name } })).toMatchObject({ unit: "kg", saleUnit: "кг" });
      }
    });
  });

  describe("last supply", () => {
    it("tells the latest cost, date and supplier of each product", async () => {
      await receipt(admin, [{ productId: juice, quantity: 3, costPrice: 12000 }], { supplierName: "ООО «Bliss»" });
      const tea = await prisma.product.findFirstOrThrow({ where: { tenantId: testTenantId, name: "Чай Ahmad 100 г" } });
      const fresh = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Новый", price: 1 } })).id;

      const res = await call("GET", `/products/last-supply?ids=${juice},${tea.id},${fresh}`, cashier);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data[juice]).toMatchObject({ costPrice: 12000, supplierName: "ООО «Bliss»" });
      expect(res.body.data[tea.id]).toMatchObject({ costPrice: 21000 });
      expect(res.body.data[fresh]).toBeUndefined();
    });

    it("never shows another shop's supplies", async () => {
      const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-forms", email: "f@x.uz" } });
      const theirs = await prisma.product.create({ data: { tenantId: other.id, name: "Чужой", price: 1 } });
      await prisma.stockReceipt.create({
        data: { tenantId: other.id, totalAmount: 1, items: { create: [{ productId: theirs.id, quantity: 1, costPrice: 1, totalCost: 1 }] } },
      });
      expect((await call("GET", `/products/last-supply?ids=${theirs.id}`, admin)).body.data).toEqual({});
    });

    it("refuses a malformed list", async () => {
      expect((await call("GET", "/products/last-supply?ids=not-a-uuid", admin)).status).toBe(400);
    });
  });
});
