import axios from "axios";
import { create } from "zustand";
import api from "./api";
import { dbGet, dbSet } from "./offlineDb";
import { useConnection } from "./connection";
import { isNoConnection } from "../utils/apiError";
import { round2 } from "../utils/money";
import { gramsPerUnit } from "../utils/weight";
import { randomId } from "../utils/id";
import type { CartItem } from "../types";

/**
 * Очередь чеков, пробитых без связи (офлайн-режим кассы магазина).
 *
 * Без связи касса принимает только наличные: чек записывается на планшет и
 * уходит на сервер сам, когда связь вернётся, — по одному, от старого к
 * новому. У каждого чека свой ключ идемпотентности, выданный в момент продажи:
 * отправка, оборвавшаяся на полпути, повторяется с тем же ключом, и сервер
 * возвращает уже записанный чек, а не создаёт второй.
 *
 * Отдельный случай — продажа ушла на сервер, а ответ не пришёл: записан чек
 * или нет, неизвестно. Такой чек сначала повторяется тем же запросом и с тем
 * же ключом. Если сервер его записал, он его и вернёт. Если сервер отказал
 * (цена изменилась, остатка нет, смену закрыли) — значит, чека нет, и он
 * уходит как офлайн-продажа: по цене, которую взяли, со своим ключом.
 *
 * Ни один чек не удаляется сам: отказ сервера переводит его в «требует
 * внимания» с причиной; повторить можно кнопкой.
 */

export interface QueuedLine {
  name: string;
  quantity: number;
  grams?: number;
  total: number;
}

export interface QueuedSale {
  id: string;
  tenantId: string;
  soldAt: number;
  total: number;
  tendered: number | null;
  lines: QueuedLine[];
  /** Запрос, который ушёл онлайн и остался без ответа. */
  online?: { key: string; body: unknown };
  offline: { key: string; body: unknown };
  stage: "online" | "offline";
  status: "pending" | "attention";
  error?: string;
  attempts: number;
}

interface QueueState {
  tenantId: string | null;
  items: QueuedSale[];
  syncing: boolean;
  /** Сколько чеков ушло за текущую отправку. */
  sentNow: number;
}

export const useOfflineQueue = create<QueueState>(() => ({ tenantId: null, items: [], syncing: false, sentNow: 0 }));

export const pendingCount = (s: QueueState) => s.items.filter((i) => i.status === "pending").length;
export const attentionCount = (s: QueueState) => s.items.filter((i) => i.status === "attention").length;

/** Повторы на непонятную ошибку сервера (500 от самого API), прежде чем звать человека. */
const MAX_SERVER_ERRORS = 5;

const keyFor = (tenantId: string) => `sales:${tenantId}`;

async function persist(): Promise<void> {
  const { tenantId, items } = useOfflineQueue.getState();
  if (tenantId) await dbSet(keyFor(tenantId), items);
}

function update(id: string, patch: Partial<QueuedSale>): void {
  useOfflineQueue.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
}

/** Поднять очередь точки с планшета (при входе на кассу). */
export async function loadQueue(tenantId: string): Promise<void> {
  const items = (await dbGet<QueuedSale[]>(keyFor(tenantId))) ?? [];
  useOfflineQueue.setState({ tenantId, items, sentNow: 0 });
}

// ── продажа без связи ───────────────────────────────────────────────────────

export interface OfflineSaleInput {
  tenantId: string;
  shiftId: string;
  cashierId?: string;
  items: CartItem[];
  total: number;
  tendered: number | null;
  customerName?: string;
  customerPhone?: string;
  /** Запрос, который ушёл онлайн без ответа, и его ключ — если так и было. */
  online?: { key: string; body: unknown };
  now?: number;
}

/** Строки чека так, как их посчитала касса: цена строки — та, что взяли с покупателя. */
export function offlineBody(input: OfflineSaleInput, soldAt: number) {
  const items = input.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    ...(item.grams ? { grams: item.grams } : {}),
    unitPrice: item.price,
  }));
  const expectedTotal = round2(items.reduce((sum, i) => sum + round2(i.unitPrice * i.quantity), 0));
  return {
    type: "takeaway",
    cashShiftId: input.shiftId,
    customerName: input.customerName || undefined,
    customerPhone: input.customerPhone || undefined,
    items,
    expectedTotal,
    payment: { method: "cash" },
    offline: { soldAt: new Date(soldAt).toISOString(), ...(input.cashierId ? { cashierId: input.cashierId } : {}) },
  };
}

/** Единицы склада, которые чек забирает (для копии каталога): штуки или кг/г по весу. */
export function stockUnits(items: CartItem[]): { productId: string; units: number }[] {
  return items.map((i) => ({
    productId: i.productId,
    units: i.grams && i.weightUnit ? (i.grams * i.quantity) / gramsPerUnit(i.weightUnit) : i.quantity,
  }));
}

export async function enqueueSale(input: OfflineSaleInput): Promise<QueuedSale> {
  const soldAt = input.now ?? Date.now();
  const sale: QueuedSale = {
    id: `offline-${randomId()}`,
    tenantId: input.tenantId,
    soldAt,
    total: input.total,
    tendered: input.tendered,
    lines: input.items.map((i) => ({ name: i.name, quantity: i.quantity, grams: i.grams, total: round2(i.price * i.quantity) })),
    online: input.online,
    offline: { key: `sale-off-${randomId()}`, body: offlineBody(input, soldAt) },
    stage: input.online ? "online" : "offline",
    status: "pending",
    attempts: 0,
  };
  if (useOfflineQueue.getState().tenantId !== input.tenantId) await loadQueue(input.tenantId);
  useOfflineQueue.setState((s) => ({ items: [...s.items, sale] }));
  await persist();
  return sale;
}

// ── отправка ────────────────────────────────────────────────────────────────

type Outcome = "sent" | "network" | "switch" | { attention: string } | "retry";

async function send(sale: QueuedSale): Promise<Outcome> {
  const part = sale.stage === "online" && sale.online ? sale.online : sale.offline;
  try {
    await api.post("/orders/checkout", part.body, { headers: { "Idempotency-Key": part.key } });
    return "sent";
  } catch (error) {
    if (isNoConnection(error)) return "network";
    if (!axios.isAxiosError(error) || !error.response) return "network";
    const { status, data } = error.response;
    const message = typeof data?.error === "string" ? data.error : `Ошибка ${status}`;
    // Онлайн-повтор отклонён по делу — значит, чек тогда не записался:
    // отправляем его как офлайн-продажу, по цене, которую взяли.
    if (sale.stage === "online" && (status === 400 || status === 404 || status === 409)) return "switch";
    if (status === 401) return "network"; // сессия: api.ts обновит токен или выведет на вход, чек подождёт
    if (status >= 500) return sale.attempts + 1 >= MAX_SERVER_ERRORS ? { attention: message } : "retry";
    return { attention: message };
  }
}

const listeners = new Set<(sent: number) => void>();

/** Подписка на «чеки ушли» — чтобы обновить каталог и остатки. */
export function onQueueSent(listener: (sent: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Отправить ожидающие чеки по одному. Обрыв связи останавливает отправку до следующего раза. */
export async function flushQueue(): Promise<number> {
  if (useOfflineQueue.getState().syncing) return 0;
  useOfflineQueue.setState({ syncing: true, sentNow: 0 });
  let sent = 0;
  try {
    for (;;) {
      const next = useOfflineQueue.getState().items.find((i) => i.status === "pending");
      if (!next) break;
      const outcome = await send(next);
      if (outcome === "network") break;
      if (outcome === "retry") {
        update(next.id, { attempts: next.attempts + 1 });
        await persist();
        break;
      }
      if (outcome === "switch") {
        update(next.id, { stage: "offline", attempts: 0 });
        await persist();
        continue;
      }
      if (outcome === "sent") {
        useOfflineQueue.setState((s) => ({ items: s.items.filter((i) => i.id !== next.id), sentNow: s.sentNow + 1 }));
        sent++;
      } else {
        update(next.id, { status: "attention", error: outcome.attention, attempts: next.attempts + 1 });
      }
      await persist();
    }
  } finally {
    useOfflineQueue.setState({ syncing: false });
  }
  if (sent > 0) for (const listener of listeners) listener(sent);
  return sent;
}

/** «Повторить» у чека, который требует внимания. */
export async function retrySale(id: string): Promise<void> {
  update(id, { status: "pending", error: undefined, attempts: 0 });
  await persist();
  await flushQueue();
}

let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Отправлять сами: при возврате связи и раз в 15 секунд, пока есть что отправить. */
export function watchQueue(): void {
  if (watching) return;
  watching = true;
  useConnection.subscribe((state, prev) => {
    if (prev.problem && !state.problem) void flushQueue();
  });
  timer = setInterval(() => {
    const state = useOfflineQueue.getState();
    if (!useConnection.getState().problem && pendingCount(state) > 0 && !state.syncing) void flushQueue();
  }, 15_000);
}

/** Для тестов. */
export function resetQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
  watching = false;
  listeners.clear();
  useOfflineQueue.setState({ tenantId: null, items: [], syncing: false, sentNow: 0 });
}
