import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";
import { formatMoney } from "../src/utils/money.js";
import { formatStock, orderStatusLabel, stockUnitOf, tenantUnits } from "../src/modules/notifications/notifications.format.js";

let adminToken: string;

interface Notification {
  id: string;
  type: "order" | "stock";
  title: string;
  message: string;
}

async function notifications(): Promise<Notification[]> {
  const res = await fetch(`${BASE_URL}/api/notifications`, { headers: { Authorization: `Bearer ${adminToken}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).data.notifications;
}

const find = (list: Notification[], id: string) => list.find((n) => n.id === id)!;

describe("Notifications", () => {
  beforeAll(async () => {
    await setupTestData();
    adminToken = (await getTokens(BASE_URL)).adminToken;
    await prisma.tenant.update({
      where: { id: testTenantId },
      data: { currency: "UZS", settings: JSON.stringify({ units: [{ key: "pack", label: "уп." }], defaultUnit: "piece" }) },
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("shows an order's amount in the shop's currency and its status in Russian", async () => {
    // Было: «Статус: completed, сумма: 22320.00 ₽» у магазина, который торгует в сумах.
    const order = await prisma.order.create({ data: { tenantId: testTenantId, orderNumber: 7, status: "completed", total: 22320 } });

    const n = find(await notifications(), `order-${order.id}`);

    expect(n.title).toBe("Заказ №7");
    expect(n.message).toMatch(/^Статус: завершён, сумма: 22\s320 сўм$/);
    expect(n.message).not.toContain("₽");
    expect(n.message).not.toContain("completed");
  });

  it("keeps cents and the dollar layout for a shop working in dollars", async () => {
    await prisma.tenant.update({ where: { id: testTenantId }, data: { currency: "USD" } });
    try {
      const order = await prisma.order.create({ data: { tenantId: testTenantId, orderNumber: 8, status: "cancelled", total: 1234.5 } });

      expect(find(await notifications(), `order-${order.id}`).message).toBe("Статус: отменён, сумма: $1,234.50");
    } finally {
      await prisma.tenant.update({ where: { id: testTenantId }, data: { currency: "UZS" } });
    }
  });

  it("counts low stock in the product's own unit", async () => {
    const apples = await prisma.product.create({
      data: { tenantId: testTenantId, name: "Яблоки", trackInventory: true, unit: "kg", saleUnit: "кг", currentStock: 0.3 - 0.1, minStock: 1, sku: "104" },
    });
    const tea = await prisma.product.create({
      data: { tenantId: testTenantId, name: "Чай", trackInventory: true, unit: "piece", currentStock: 3, minStock: 5 },
    });
    const juice = await prisma.product.create({
      data: { tenantId: testTenantId, name: "Сок", trackInventory: true, unit: "pack", currentStock: 4, minStock: 10, sku: "J-1" },
    });

    const list = await notifications();

    expect(find(list, `stock-${apples.id}`)).toMatchObject({ type: "stock", title: "Низкий остаток: Яблоки", message: "Осталось 0,2 кг (SKU: 104)" });
    // без SKU — без «(SKU: null)»
    expect(find(list, `stock-${tea.id}`).message).toBe("Осталось 3 шт.");
    // единица, добавленная магазином в настройках, — её подписью
    expect(find(list, `stock-${juice.id}`).message).toBe("Осталось 4 уп. (SKU: J-1)");
  });

  it("warns when stock is down to the product's own minimum, not to a fixed 5", async () => {
    const make = (name: string, currentStock: number, minStock: number, extra: Record<string, unknown> = {}) =>
      prisma.product.create({ data: { tenantId: testTenantId, name, trackInventory: true, currentStock, minStock, ...extra } });

    // По старому правилу «≤ 5» первые три не попали бы сюда, а «выше минимума» и
    // «без минимума» — попали бы.
    const below = await make("Ниже минимума", 12, 20);
    const atMinimum = await make("На минимуме", 20, 20);
    const grams = await make("Чай на развес", 400, 500, { saleUnit: "г" });
    const soldOut = await make("Закончился", 0, 0);
    const above = await make("Выше минимума", 3, 2);
    const noMinimum = await make("Без минимума", 3, 0);
    const untracked = await make("Без учёта", 0, 5, { trackInventory: false });
    const archived = await make("В архиве", 0, 5, { isActive: false });

    const list = await notifications();
    const ids = list.map((n) => n.id);

    expect(ids).toEqual(expect.arrayContaining([below, atMinimum, grams, soldOut].map((p) => `stock-${p.id}`)));
    for (const p of [above, noMinimum, untracked, archived]) expect(ids).not.toContain(`stock-${p.id}`);
    expect(find(list, `stock-${grams.id}`).message).toBe("Осталось 400 г");
  });

  it("never shows another shop's orders or stock", async () => {
    const other = await prisma.tenant.create({ data: { name: "Other", slug: "other-shop", email: "o@test.com", currency: "UZS" } });
    const order = await prisma.order.create({ data: { tenantId: other.id, orderNumber: 1, total: 1000 } });
    const product = await prisma.product.create({ data: { tenantId: other.id, name: "Чужой", trackInventory: true, currentStock: 1, minStock: 5 } });

    const ids = (await notifications()).map((n) => n.id);

    expect(ids).not.toContain(`order-${order.id}`);
    expect(ids).not.toContain(`stock-${product.id}`);
  });
});

describe("Notification texts", () => {
  it("formats money by the same rules as the admin panel and the terminal", () => {
    expect(formatMoney(22320, "UZS")).toMatch(/^22\s320 сўм$/);
    expect(formatMoney(22320.4, "uzs")).toMatch(/^22\s320 сўм$/);
    expect(formatMoney(1234.5, "USD")).toBe("$1,234.50");
    expect(formatMoney(1234.5, "EUR")).toBe("1.234,50 €");
    expect(formatMoney(1234.5, "RUB")).toMatch(/^1\s234,50 ₽$/);
    expect(formatMoney(5, null)).toMatch(/^5 сўм$/); // без валюты — сумы
    expect(formatMoney(5, "GBP")).toBe("5,00 GBP");
  });

  it("names every order status the way the order badges do, and passes unknown ones through", () => {
    expect(["pending", "confirmed", "preparing", "ready", "served", "completed", "cancelled"].map(orderStatusLabel)).toEqual([
      "ожидает",
      "подтверждён",
      "готовится",
      "готов",
      "подан",
      "завершён",
      "отменён",
    ]);
    expect(orderStatusLabel("something_new")).toBe("something_new");
  });

  it("prefers the sale unit, understands keys and short labels, and falls back to pieces", () => {
    expect(stockUnitOf({ saleUnit: "кг", unit: "piece" })).toBe("кг");
    expect(stockUnitOf({ saleUnit: null, unit: "kg" })).toBe("кг");
    expect(stockUnitOf({ saleUnit: "г" })).toBe("г");
    expect(stockUnitOf({ unit: "шт" })).toBe("шт.");
    expect(stockUnitOf({ unit: "ml" })).toBe("мл");
    expect(stockUnitOf({ unit: "box" })).toBe("box");
    expect(stockUnitOf({ unit: "box" }, [{ key: "box", label: "кор." }])).toBe("кор.");
    expect(stockUnitOf({})).toBe("шт.");
    expect(formatStock({ currentStock: 82.96000000000001, saleUnit: "кг" })).toBe("82,96 кг");
    expect(formatStock({ currentStock: 1.2346, saleUnit: "кг" })).toBe("1,235 кг");
  });

  it("reads the shop's own units and ignores broken settings", () => {
    expect(tenantUnits(JSON.stringify({ units: [{ key: "pack", label: "уп." }, { key: 1 }, null] }))).toEqual([{ key: "pack", label: "уп." }]);
    expect(tenantUnits("{not json")).toEqual([]);
    expect(tenantUnits("null")).toEqual([]);
    expect(tenantUnits(undefined)).toEqual([]);
  });
});
