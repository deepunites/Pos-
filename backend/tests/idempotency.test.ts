import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestData, getTokens, cleanupTestData, prisma, testTenantId, BASE_URL } from "./helpers.js";
import { purgeIdempotencyKeys } from "../src/utils/idempotency.js";

// Касса, у которой оборвалась связь посреди продажи, не знает, прошла ли
// продажа, и шлёт её ещё раз. Кассир, дважды нажавший «Оплатить», — тоже.
// С заголовком Idempotency-Key повтор возвращает уже созданное, а не
// создаёт второй чек и не списывает товар второй раз.

let token: string;
let categoryId: string;
let seq = 0;

const send = (path: string, body: unknown, key?: string) =>
  fetch(`${BASE_URL}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });

const newKey = () => crypto.randomUUID();

async function product(currentStock: number) {
  seq += 1;
  return prisma.product.create({
    data: { tenantId: testTenantId, categoryId, name: `Товар ${seq}`, price: 10, costPrice: 4, sku: `IDEM-${seq}`, currentStock, trackInventory: true },
  });
}

const sale = (productId: string) => ({
  type: "takeaway",
  items: [{ productId, quantity: 1 }],
  expectedTotal: 10,
  payment: { method: "cash" },
});

describe("Idempotency-Key", () => {
  beforeAll(async () => {
    await setupTestData();
    token = (await getTokens(BASE_URL)).adminToken;
    categoryId = (await prisma.category.findFirstOrThrow({ where: { tenantId: testTenantId } })).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("returns the same sale for a repeated checkout and writes stock off once", async () => {
    const p = await product(10);
    const key = newKey();

    const first = await send("/orders/checkout", sale(p.id), key);
    const again = await send("/orders/checkout", sale(p.id), key);
    const a = (await first.json()) as any;
    const b = (await again.json()) as any;

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(b.data.id).toBe(a.data.id);
    expect(await prisma.order.count({ where: { items: { some: { productId: p.id } } } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).currentStock).toBe(9);
  });

  it("creates one sale when the same request arrives five times at once", async () => {
    const p = await product(10);
    const key = newKey();

    const responses = await Promise.all(Array.from({ length: 5 }, () => send("/orders/checkout", sale(p.id), key)));
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as any[];

    for (const [i, r] of responses.entries()) expect(r.status, JSON.stringify(bodies[i])).toBe(201);
    expect(new Set(bodies.map((b) => b.data.id)).size).toBe(1);
    expect(await prisma.order.count({ where: { items: { some: { productId: p.id } } } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).currentStock).toBe(9);
  });

  it("refuses a key reused for a different request", async () => {
    const p = await product(10);
    const key = newKey();

    expect((await send("/orders/checkout", sale(p.id), key)).status).toBe(201);
    const other = await send("/orders/checkout", { ...sale(p.id), customerName: "Другой" }, key);

    expect(other.status).toBe(422);
    expect(((await other.json()) as any).error).toMatch(/Idempotency-Key/);
  });

  it("does not burn the key when the request fails", async () => {
    const p = await product(0);
    const key = newKey();

    const short = await send("/orders/checkout", sale(p.id), key);
    expect(short.ok).toBe(false);

    await prisma.product.update({ where: { id: p.id }, data: { currentStock: 5 } });
    const retry = await send("/orders/checkout", sale(p.id), key);

    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBeNull();
  });

  it("takes one payment for a repeated payment request", async () => {
    const p = await product(10);
    const order = ((await (await send("/orders", { type: "takeaway", items: [{ productId: p.id, quantity: 1 }] })).json()) as any).data;
    const key = newKey();
    const body = { orderId: order.id, method: "cash", amount: order.total };

    const first = await send("/payments", body, key);
    const again = await send("/payments", body, key);

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(((await again.json()) as any).data.id).toBe(((await first.json()) as any).data.id);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("records one stock receipt for a repeated delivery", async () => {
    const p = await product(10);
    const key = newKey();
    const body = { items: [{ productId: p.id, quantity: 5, costPrice: 4 }] };

    expect((await send("/stock-receipts", body, key)).status).toBe(201);
    expect((await send("/stock-receipts", body, key)).status).toBe(201);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).currentStock).toBe(15);
  });

  it("works as before without the header", async () => {
    const p = await product(10);

    await send("/orders/checkout", sale(p.id));
    await send("/orders/checkout", sale(p.id));

    expect(await prisma.order.count({ where: { items: { some: { productId: p.id } } } })).toBe(2);
  });

  it("rejects a malformed key", async () => {
    const p = await product(10);
    const res = await send("/orders/checkout", sale(p.id), "x");
    expect(res.status).toBe(400);
  });

  // Неделя, а не сутки: чек, пробитый без связи, может дойти через несколько
  // дней (офлайн-режим кассы), и его повтор должен узнать записанную продажу.
  it("remembers keys for a week, then forgets them", async () => {
    const p = await product(10);
    const key = newKey();
    expect((await send("/orders/checkout", sale(p.id), key)).status).toBe(201);

    await prisma.idempotencyKey.updateMany({ where: { key }, data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    await purgeIdempotencyKeys();
    expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(1);

    await prisma.idempotencyKey.updateMany({ where: { key }, data: { createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    await purgeIdempotencyKeys();
    expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(0);
  });
});
