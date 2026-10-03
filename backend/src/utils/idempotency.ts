import crypto from "node:crypto";
import type { Request } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/database.js";
import type { Tx } from "../modules/inventory/stock.helpers.js";
import { AppError } from "./errors.js";

/**
 * Идемпотентность по заголовку Idempotency-Key.
 *
 * Касса, у которой оборвалась связь посреди продажи, не знает, дошла ли
 * продажа, и шлёт её ещё раз. Без ключа сервер не отличит повтор от новой
 * продажи: два чека, два списания со склада. С ключом:
 *
 *  - первая строка транзакции продажи — вставка ключа (claimIdempotencyKey),
 *    последняя — id созданного (attachIdempotencyResource). Ключ и продажа
 *    фиксируются вместе или не фиксируются вовсе: упавшая продажа ключ не
 *    «сжигает», и повтор с тем же ключом пройдёт заново;
 *  - повтор, пришедший после — находит ключ и возвращает уже созданное;
 *  - повтор, пришедший одновременно, ждёт на первичном ключе, пока первая
 *    транзакция не закончится, получает нарушение уникальности, откатывается
 *    и тоже возвращает созданное первой (withIdempotency).
 *
 * Без заголовка всё работает как раньше.
 */
export interface IdempotencyContext {
  key: string;
  route: string;
  requestHash: string;
}

// Неделя: чек, пробитый без связи, может дойти через несколько дней (офлайн-
// режим кассы), и его повтор должен узнать уже записанную продажу.
export const IDEMPOTENCY_TTL_HOURS = 7 * 24;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

// Тело запроса в одну форму: ключи объектов отсортированы, чтобы один и тот же
// запрос, собранный в другом порядке полей, считался тем же самым.
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export function idempotencyFrom(req: Request, route: string): IdempotencyContext | null {
  const header = req.get("Idempotency-Key");
  if (header === undefined) return null;
  const key = header.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new AppError("Idempotency-Key — от 8 до 128 символов: латиница, цифры и . _ : -", 400);
  }
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(stable(req.body ?? null))).digest("hex");
  return { key, route, requestHash };
}

async function storedResource(tenantId: string, ctx: IdempotencyContext): Promise<string | null> {
  const row = await prisma.idempotencyKey.findUnique({ where: { tenantId_key: { tenantId, key: ctx.key } } });
  if (!row) return null;
  if (row.route !== ctx.route || row.requestHash !== ctx.requestHash) {
    throw new AppError("Этот Idempotency-Key уже использован для другого запроса", 422);
  }
  return row.resourceId;
}

export async function claimIdempotencyKey(tx: Tx, tenantId: string, ctx: IdempotencyContext | null | undefined): Promise<void> {
  if (!ctx) return;
  await tx.idempotencyKey.create({ data: { tenantId, key: ctx.key, route: ctx.route, requestHash: ctx.requestHash } });
}

export async function attachIdempotencyResource(
  tx: Tx,
  tenantId: string,
  ctx: IdempotencyContext | null | undefined,
  resourceId: string
): Promise<void> {
  if (!ctx) return;
  await tx.idempotencyKey.update({ where: { tenantId_key: { tenantId, key: ctx.key } }, data: { resourceId } });
}

/**
 * run — сама операция (вызывает claim… в начале своей транзакции и attach… в
 * конце); load — как прочитать уже созданное по id для ответа на повтор.
 */
export async function withIdempotency<T>(
  tenantId: string,
  ctx: IdempotencyContext | null,
  run: () => Promise<T>,
  load: (resourceId: string) => Promise<T>
): Promise<{ value: T; replayed: boolean }> {
  if (!ctx) return { value: await run(), replayed: false };

  const done = await storedResource(tenantId, ctx);
  if (done) return { value: await load(done), replayed: true };

  try {
    return { value: await run(), replayed: false };
  } catch (error) {
    // Одновременный повтор: первая транзакция уже зафиксировала ключ.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await storedResource(tenantId, ctx);
      if (winner) return { value: await load(winner), replayed: true };
    }
    throw error;
  }
}

/** Удаляет ключи старше суток — зовётся из фоновой уборки (orders/order.cleanup.ts). */
export async function purgeIdempotencyKeys(olderThanHours = IDEMPOTENCY_TTL_HOURS): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanHours * 3600 * 1000) } },
  });
  return count;
}
