import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";
import { debtLabel, oldestUnpaidDebt } from "../src/modules/customers/customer.debt.js";

// Клиенты магазина и продажа в долг: «чек 60 000 — запиши в долг», «20 000
// наличными, 40 000 в долг», погашение на кассе, метки по возрасту долга.

let admin: string;
let cashier: string;
let productId: string;
let shiftId: string;

const call = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as any, text };
};

const newCustomer = (data: Record<string, unknown>) => call("POST", "/customers", cashier, data);
const sale = (payments: unknown[], extra: Record<string, unknown> = {}) =>
  call("POST", "/orders/checkout", cashier, {
    type: "takeaway",
    cashShiftId: shiftId,
    items: [{ productId, quantity: 1 }],
    expectedTotal: 60000,
    payments,
    ...extra,
  });
const balance = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id } })).debtBalance;
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000);

describe("Customers and debt", () => {
  beforeAll(async () => {
    await setupTestData();
    ({ adminToken: admin, cashierToken: cashier } = await getTokens(BASE_URL));
    await prisma.tenant.update({ where: { id: testTenantId }, data: { businessType: "retail", currency: "UZS", taxRate: 0 } });
    productId = (await prisma.product.create({ data: { tenantId: testTenantId, name: "Сок", price: 60000, trackInventory: true, currentStock: 100 } })).id;
    shiftId = (await call("POST", "/cash-shifts/open", cashier, { openingCash: 100000 })).body.data.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("customers", () => {
    it("are created by the cashier with the phone stored as +998 and nine digits", async () => {
      const res = await newCustomer({ firstName: "Алишер", lastName: "Каримов", phone: "90 123-45-67" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ firstName: "Алишер", phone: "+998901234567", debtBalance: 0, label: "ok" });
    });

    it("do not repeat a phone within the shop", async () => {
      const res = await newCustomer({ firstName: "Другой", phone: "+998901234567" });
      expect(res.status).toBe(409);
    });

    it("refuse a phone that is not +998 and nine digits", async () => {
      expect((await newCustomer({ firstName: "Без номера", phone: "12345" })).status).toBe(400);
    });

    it("are found by the last digits of the phone and by name in any case", async () => {
      await newCustomer({ firstName: "Шахзода", lastName: "Миржалилова", phone: "+998937144567" });
      const byPhone = await call("GET", "/customers?search=4567", cashier);
      expect(byPhone.body.data.map((c: any) => c.firstName).sort()).toEqual(["Алишер", "Шахзода"]);
      const byName = await call("GET", `/customers?search=${encodeURIComponent("каРИмов")}`, cashier);
      expect(byName.body.data.map((c: any) => c.firstName)).toEqual(["Алишер"]);
    });

    it("are rated and blocked by the admin, not by the cashier", async () => {
      const c = (await newCustomer({ firstName: "Рустам", phone: "+998914044567" })).body.data;
      expect((await call("PATCH", `/customers/${c.id}`, cashier, { rating: 2 })).status).toBe(403);
      const res = await call("PATCH", `/customers/${c.id}`, admin, { rating: 3, note: "Берёт в пятницу", debtBlocked: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ rating: 3, note: "Берёт в пятницу", debtBlocked: true, label: "blocked" });
    });

    it("are never seen by another shop", async () => {
      const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-debt-shop", email: "o@x.uz" } });
      const stranger = await prisma.customer.create({ data: { tenantId: other.id, firstName: "Чужой", phone: "+998901110000" } });
      const list = (await call("GET", "/customers", cashier)).body.data.map((c: any) => c.id);
      expect(list).not.toContain(stranger.id);
      expect((await call("GET", `/customers/${stranger.id}`, cashier)).status).toBe(404);
      expect((await sale([{ method: "debt", amount: 60000 }], { customerId: stranger.id })).status).toBe(404);
    });
  });

  describe("selling on credit", () => {
    it("writes the whole check to the customer's debt and keeps it out of the cash drawer", async () => {
      const c = (await newCustomer({ firstName: "Дилноза", phone: "+998992103344" })).body.data;
      const before = (await call("GET", "/cash-shifts/current", cashier)).body.data;

      const res = await sale([{ method: "debt", amount: 60000 }], { customerId: c.id });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ customerId: c.id, customerName: "Дилноза", customerPhone: "+998992103344" });
      expect(await balance(c.id)).toBe(60000);

      const entries = await prisma.customerDebtEntry.findMany({ where: { customerId: c.id } });
      expect(entries.map((e) => [e.type, e.amount, e.orderId, e.cashShiftId])).toEqual([["sale", 60000, res.body.data.id, shiftId]]);

      const after = (await call("GET", "/cash-shifts/current", cashier)).body.data;
      expect(after.totalDebtSales - before.totalDebtSales).toBe(60000);
      expect(after.totalSales - before.totalSales).toBe(60000);
      expect(after.expectedCash).toBe(before.expectedCash);
    });

    it("takes part now in cash or by card and writes the rest to the debt", async () => {
      const c = (await newCustomer({ firstName: "Бобур", phone: "+998977001122" })).body.data;
      const cash = await sale([{ method: "cash", amount: 20000 }, { method: "debt", amount: 40000 }], { customerId: c.id });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      const card = await sale([{ method: "card", amount: 50000 }, { method: "debt", amount: 10000 }], { customerId: c.id });
      expect(card.status).toBe(201);
      expect(await balance(c.id)).toBe(50000);
    });

    it("needs a customer, a connection and a customer allowed credit", async () => {
      expect((await sale([{ method: "debt", amount: 60000 }])).status).toBe(400);

      const c = (await newCustomer({ firstName: "Офлайн", phone: "+998977003344" })).body.data;
      const offline = await call("POST", "/orders/checkout", cashier, {
        type: "takeaway",
        items: [{ productId, quantity: 1, unitPrice: 60000 }],
        expectedTotal: 60000,
        payments: [{ method: "debt", amount: 60000 }],
        customerId: c.id,
        offline: { soldAt: new Date().toISOString() },
      });
      expect(offline.status).toBe(400);

      const blocked = (await newCustomer({ firstName: "Стоп", phone: "+998977005566" })).body.data;
      await call("PATCH", `/customers/${blocked.id}`, admin, { debtBlocked: true });
      const refused = await sale([{ method: "debt", amount: 60000 }], { customerId: blocked.id });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/не продаём/);
      expect(await balance(blocked.id)).toBe(0);
    });

    it("refuses credit when an old debt has hung for 60 days, warns from 30", async () => {
      const late = await prisma.customer.create({ data: { tenantId: testTenantId, firstName: "Должник", phone: "+998977007788", debtBalance: 100000 } });
      await prisma.customerDebtEntry.create({ data: { tenantId: testTenantId, customerId: late.id, type: "sale", amount: 100000, createdAt: daysAgo(61) } });
      expect((await sale([{ method: "debt", amount: 60000 }], { customerId: late.id })).status).toBe(409);

      const slow = await prisma.customer.create({ data: { tenantId: testTenantId, firstName: "Медленный", phone: "+998977009900", debtBalance: 100000 } });
      await prisma.customerDebtEntry.create({ data: { tenantId: testTenantId, customerId: slow.id, type: "sale", amount: 100000, createdAt: daysAgo(35) } });
      expect((await sale([{ method: "debt", amount: 60000 }], { customerId: slow.id })).status).toBe(201);

      const list = (await call("GET", "/customers?withDebt=true", cashier)).body.data;
      const label = (id: string) => list.find((c: any) => c.id === id)?.label;
      expect(label(late.id)).toBe("blocked");
      expect(label(slow.id)).toBe("warn");
    });

    it("gives the debt back when the credit part of the check is refunded", async () => {
      const c = (await newCustomer({ firstName: "Возврат", phone: "+998977112233" })).body.data;
      const res = await sale([{ method: "cash", amount: 20000 }, { method: "debt", amount: 40000 }], { customerId: c.id });
      const debtPayment = await prisma.payment.findFirstOrThrow({ where: { orderId: res.body.data.id, method: "debt" } });
      const refund = await call("POST", `/payments/${debtPayment.id}/refund`, admin, { reason: "Вернул товар" });
      expect(refund.status, JSON.stringify(refund.body)).toBe(200);
      expect(await balance(c.id)).toBe(0);
      const types = (await prisma.customerDebtEntry.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "asc" } })).map((e) => [e.type, e.amount]);
      expect(types).toEqual([["sale", 40000], ["refund", -40000]]);
    });

    it("prints the credit and the customer's debt on the receipt", async () => {
      const c = (await newCustomer({ firstName: "Чек", lastName: "Печатный", phone: "+998977445566" })).body.data;
      const res = await sale([{ method: "cash", amount: 20000 }, { method: "debt", amount: 40000 }], { customerId: c.id });
      const receipt = (await call("GET", `/receipts/${res.body.data.id}`, cashier)).text;
      expect(receipt).toContain("В долг");
      expect(receipt).toContain("Чек Печатный");
      expect(receipt).toMatch(/Долг клиента:[\s\S]*40\s000/);
    });
  });

  describe("repayments", () => {
    it("take money at the register into its shift and lower the debt", async () => {
      const c = (await newCustomer({ firstName: "Платит", phone: "+998977667788" })).body.data;
      await sale([{ method: "debt", amount: 60000 }], { customerId: c.id });
      const before = (await call("GET", "/cash-shifts/current", cashier)).body.data;

      const cash = await call("POST", `/customers/${c.id}/repayments`, cashier, { amount: 25000, method: "cash", cashShiftId: shiftId });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      expect(cash.body.data.customer.debtBalance).toBe(35000);
      const card = await call("POST", `/customers/${c.id}/repayments`, cashier, { amount: 5000, method: "card", cashShiftId: shiftId });
      expect(card.status).toBe(201);

      const after = (await call("GET", "/cash-shifts/current", cashier)).body.data;
      expect(after.totalDebtRepaidCash - before.totalDebtRepaidCash).toBe(25000);
      expect(after.totalDebtRepaidCard - before.totalDebtRepaidCard).toBe(5000);
      expect(after.expectedCash - before.expectedCash).toBe(25000);
      expect(await balance(c.id)).toBe(30000);
    });

    it("are taken once when the register repeats the request", async () => {
      const c = (await newCustomer({ firstName: "Повтор", phone: "+998977889900" })).body.data;
      await sale([{ method: "debt", amount: 60000 }], { customerId: c.id });
      const key = { "Idempotency-Key": `repay-${c.id}` };
      const body = { amount: 10000, method: "cash", cashShiftId: shiftId };
      const first = await call("POST", `/customers/${c.id}/repayments`, cashier, body, key);
      const again = await call("POST", `/customers/${c.id}/repayments`, cashier, body, key);
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.body.data.entry.id).toBe(first.body.data.entry.id);
      expect(await balance(c.id)).toBe(50000);
    });

    it("cannot be more than the debt, and the admin takes them without a shift", async () => {
      const c = (await newCustomer({ firstName: "Админ", phone: "+998977990011" })).body.data;
      await sale([{ method: "debt", amount: 60000 }], { customerId: c.id });
      expect((await call("POST", `/customers/${c.id}/repayments`, cashier, { amount: 70000, method: "cash" })).status).toBe(400);
      const res = await call("POST", `/customers/${c.id}/repayments`, admin, { amount: 60000, method: "card" });
      expect(res.status).toBe(201);
      expect(res.body.data.customer).toMatchObject({ debtBalance: 0, label: "ok" });
      const detail = (await call("GET", `/customers/${c.id}`, admin)).body.data;
      expect(detail.history.map((e: any) => e.type)).toEqual(["repayment", "sale"]);
    });
  });

  describe("debt age", () => {
    it("closes the oldest debts first", () => {
      const at = (days: number) => daysAgo(days);
      expect(oldestUnpaidDebt([])).toBeNull();
      expect(oldestUnpaidDebt([{ amount: 100, createdAt: at(40) }, { amount: -100, createdAt: at(5) }])).toBeNull();
      // 100 сорок дней назад, 50 десять дней назад, погасили 100 → висит только свежий
      const since = oldestUnpaidDebt([
        { amount: 100, createdAt: at(40) },
        { amount: 50, createdAt: at(10) },
        { amount: -100, createdAt: at(2) },
      ]);
      expect(Math.round((Date.now() - since!.getTime()) / 86400000)).toBe(10);
    });

    it("labels ok, warn after 30 days, blocked after 60 or by hand", () => {
      expect(debtLabel({ debtBlocked: false, debtBalance: 0 }, null)).toBe("ok");
      expect(debtLabel({ debtBlocked: false, debtBalance: 10 }, daysAgo(29))).toBe("ok");
      expect(debtLabel({ debtBlocked: false, debtBalance: 10 }, daysAgo(30))).toBe("warn");
      expect(debtLabel({ debtBlocked: false, debtBalance: 10 }, daysAgo(60))).toBe("blocked");
      expect(debtLabel({ debtBlocked: true, debtBalance: 0 }, null)).toBe("blocked");
    });
  });
});
