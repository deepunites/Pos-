import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CartItem } from "../types";

vi.mock("./api", () => ({ default: { post: vi.fn(), get: vi.fn() } }));

import api from "./api";
import { dbGet, resetOfflineDb } from "./offlineDb";
import {
  attentionCount,
  enqueueSale,
  flushQueue,
  offlineBody,
  onQueueSent,
  pendingCount,
  resetQueue,
  retrySale,
  stockUnits,
  useOfflineQueue,
} from "./offlineQueue";
import { OFFLINE_LIMIT_MS, noteServerContact, offlineTooLong } from "./connection";

const post = api.post as unknown as ReturnType<typeof vi.fn>;

const TENANT = "tenant-1";
const SHIFT = "11111111-1111-4111-8111-111111111111";

const bread: CartItem = { id: "l1", productId: "p-bread", name: "Хлеб", price: 5000, quantity: 2 } as CartItem;
const apples: CartItem = { id: "l2", productId: "p-apples", name: "Яблоки", price: 27000, quantity: 1, grams: 1500, rate: 18000, weightUnit: "кг" } as CartItem;

const noAnswer = () => new AxiosError("Network Error", "ERR_NETWORK", undefined, {}, undefined);
function answer(status: number, error = "Ошибка"): AxiosError {
  const response = { status, data: { success: false, error }, statusText: "", headers: {}, config: { headers: new AxiosHeaders() } } as AxiosResponse;
  return new AxiosError(error, "ERR_BAD_RESPONSE", undefined, {}, response);
}
const ok = () => Promise.resolve({ data: { success: true, data: { id: "order-1" } } });

const sale = (items: CartItem[] = [bread], extra: Partial<Parameters<typeof enqueueSale>[0]> = {}) =>
  enqueueSale({ tenantId: TENANT, shiftId: SHIFT, cashierId: "cashier-1", items, total: 10000, tendered: 20000, ...extra });

const keysSent = () => post.mock.calls.map((call) => (call[2] as { headers: Record<string, string> }).headers["Idempotency-Key"]);

describe("очередь офлайн-чеков", () => {
  beforeEach(() => {
    resetQueue();
    resetOfflineDb();
    post.mockReset();
  });
  afterEach(() => resetQueue());

  it("пишет чек так, как его посчитала касса: цена строки — взятая, только наличные, время продажи", () => {
    const body = offlineBody({ tenantId: TENANT, shiftId: SHIFT, cashierId: "cashier-1", items: [bread, apples], total: 37000, tendered: null }, Date.parse("2026-10-03T08:00:00Z"));
    expect(body).toMatchObject({
      cashShiftId: SHIFT,
      expectedTotal: 37000, // 5000 × 2 + 27000 — так же, как итог корзины
      payment: { method: "cash" },
      offline: { soldAt: "2026-10-03T08:00:00.000Z", cashierId: "cashier-1" },
    });
    expect(body.items).toEqual([
      { productId: "p-bread", quantity: 2, unitPrice: 5000 },
      { productId: "p-apples", quantity: 1, grams: 1500, unitPrice: 27000 },
    ]);
  });

  it("считает, сколько чек забирает со склада: штуки и килограммы", () => {
    expect(stockUnits([bread, apples])).toEqual([
      { productId: "p-bread", units: 2 },
      { productId: "p-apples", units: 1.5 },
    ]);
  });

  it("хранит чек на планшете, пока он не ушёл", async () => {
    await sale();
    expect(pendingCount(useOfflineQueue.getState())).toBe(1);
    expect(await dbGet(`sales:${TENANT}`)).toHaveLength(1);
  });

  it("отправляет чеки по одному, от старого к новому, и убирает отправленные", async () => {
    const first = await sale();
    const second = await sale([apples]);
    post.mockImplementation(ok);
    const listener = vi.fn();
    onQueueSent(listener);

    expect(await flushQueue()).toBe(2);

    expect(keysSent()).toEqual([first.offline.key, second.offline.key]);
    expect(useOfflineQueue.getState().items).toEqual([]);
    expect(listener).toHaveBeenCalledWith(2);
  });

  it("без связи останавливается и ничего не теряет; повтор идёт с тем же ключом", async () => {
    const first = await sale();
    await sale([apples]);
    post.mockRejectedValueOnce(noAnswer());

    expect(await flushQueue()).toBe(0);
    expect(pendingCount(useOfflineQueue.getState())).toBe(2);
    expect(post).toHaveBeenCalledTimes(1); // второй не пытался — связи нет

    post.mockImplementation(ok);
    await flushQueue();
    expect(keysSent()[1]).toBe(first.offline.key); // тот же ключ — сервер не создаст второй чек
    expect(useOfflineQueue.getState().items).toEqual([]);
  });

  it("чек, ушедший онлайн без ответа, сначала повторяется тем же запросом — сервер вернёт записанный", async () => {
    const online = { key: "sale-online-1", body: { expectedTotal: 10000 } };
    const queued = await sale([bread], { online });
    post.mockImplementation(ok);

    await flushQueue();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toBe(online.body);
    expect(keysSent()).toEqual(["sale-online-1"]);
    expect(queued.stage).toBe("online");
  });

  it("если сервер отказал онлайн-повтору (цена изменилась), чека нет — уходит офлайн-продажей со своим ключом", async () => {
    const online = { key: "sale-online-2", body: { expectedTotal: 10000 } };
    const queued = await sale([bread], { online });
    post.mockRejectedValueOnce(answer(409, "Сумма заказа изменилась")).mockImplementation(ok);

    await flushQueue();

    expect(keysSent()).toEqual(["sale-online-2", queued.offline.key]);
    expect((post.mock.calls[1][1] as { offline?: unknown }).offline).toBeDefined();
    expect(useOfflineQueue.getState().items).toEqual([]);
  });

  it("отказ сервера офлайн-чеку не теряет его: «требует внимания», с причиной, остальные идут дальше", async () => {
    await sale();
    const second = await sale([apples]);
    post.mockRejectedValueOnce(answer(404, "Смена не найдена")).mockImplementation(ok);

    await flushQueue();

    const items = useOfflineQueue.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "attention", error: "Смена не найдена" });
    expect(keysSent()[1]).toBe(second.offline.key);
    expect(attentionCount(useOfflineQueue.getState())).toBe(1);
  });

  it("«Повторить» отправляет чек ещё раз, с тем же ключом", async () => {
    const queued = await sale();
    post.mockRejectedValueOnce(answer(400, "Строки не сходятся"));
    await flushQueue();
    expect(attentionCount(useOfflineQueue.getState())).toBe(1);

    post.mockImplementation(ok);
    await retrySale(queued.id);

    expect(keysSent()).toEqual([queued.offline.key, queued.offline.key]);
    expect(useOfflineQueue.getState().items).toEqual([]);
  });

  it("на сбой самого сервера пробует ещё несколько раз, прежде чем звать человека", async () => {
    await sale();
    post.mockRejectedValue(answer(500, "Внутренняя ошибка"));

    for (let i = 0; i < 4; i++) await flushQueue();
    expect(useOfflineQueue.getState().items[0]).toMatchObject({ status: "pending", attempts: 4 });

    await flushQueue();
    expect(useOfflineQueue.getState().items[0]).toMatchObject({ status: "attention", error: "Внутренняя ошибка" });
  });

  it("две отправки сразу не идут: вторая ждёт первую", async () => {
    await sale();
    let release: (v: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const a = flushQueue();
    const b = await flushQueue();
    release({ data: {} });
    await a;

    expect(b).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("сколько касса без связи", () => {
  beforeEach(() => localStorage.clear());

  it("дольше двух суток без ответа сервера — продавать без связи нельзя", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(offlineTooLong(now)).toBe(false); // ещё ни разу не говорили — не повод блокировать

    noteServerContact(now - OFFLINE_LIMIT_MS + 60_000);
    expect(offlineTooLong(now)).toBe(false);

    noteServerContact(now - OFFLINE_LIMIT_MS - 60_000);
    expect(offlineTooLong(now)).toBe(true);
  });
});
