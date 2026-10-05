import prisma from "../../config/database.js";
import { alerts } from "../../utils/alerts.js";
import { logger } from "../../utils/logger.js";
import { releaseStock, stockUnitsFor, type Reservation } from "../inventory/stock.helpers.js";
import { inTransaction } from "../../utils/transaction.js";
import { lockOrder } from "./order.locks.js";
import { purgeIdempotencyKeys } from "../../utils/idempotency.js";

// Creating an order reserves stock. A terminal that crashes (or a cashier who
// walks away) between the order and its payment would otherwise hold that
// stock forever, making goods look sold out. Unpaid, untouched orders are
// therefore cancelled after a grace period and their reservation released.
export async function cancelStalePendingOrders(maxAgeMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: {
      status: "pending",
      createdAt: { lt: cutoff },
      payments: { none: { status: "completed" } },
    },
    select: { id: true, tenantId: true, notes: true },
  });

  let cancelled = 0;
  for (const order of stale) {
    try {
      // Список выше прочитан без блокировок, поэтому каждый заказ проверяется
      // заново под блокировкой его строки. Заказ, который прямо сейчас
      // оплачивают, держит оплата — его пропускаем (SKIP LOCKED), а не ждём.
      // Раньше отмена могла совпасть с оплатой: деньги приняты, заказ отменён,
      // резерв вернулся на склад.
      const done = await inTransaction(async (tx) => {
        const locked = await lockOrder(tx, order.tenantId, order.id, { skipLocked: true });
        if (!locked || locked.status !== "pending") return false;
        const paid = await tx.payment.count({ where: { orderId: order.id, status: "completed" } });
        if (paid > 0) return false;

        const items = await tx.orderItem.findMany({ where: { orderId: order.id }, include: { product: true } });
        const reservations: Reservation[] = items
          .filter((item) => item.product.trackInventory)
          .map((item) => ({ productId: item.productId, name: item.product.name, units: stockUnitsFor(item, item.product.saleUnit) }));

        await releaseStock(tx, { tenantId: order.tenantId, orderId: order.id, reservations });
        await tx.order.update({
          where: { id: order.id },
          data: { status: "cancelled", notes: [order.notes, "Отменён автоматически: не оплачен"].filter(Boolean).join("\n") },
        });
        if (locked.tableId) {
          await tx.table.update({ where: { id: locked.tableId }, data: { status: "available" } });
        }
        return true;
      });
      if (done) cancelled += 1;
    } catch (error) {
      logger.error("Failed to cancel stale order", {
        orderId: order.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (cancelled > 0) logger.info(`Cancelled ${cancelled} stale pending order(s)`);
  return cancelled;
}

export function startStaleOrderSweeper(maxAgeMinutes: number, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const timer = setInterval(() => {
    cancelStalePendingOrders(maxAgeMinutes).catch((error) => {
      logger.error("Stale order sweep failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      alerts.report(error, { where: "фоновая отмена неоплаченных заказов" });
    });
    // Ключи идемпотентности старше суток больше не нужны: повтор приходит
    // через секунды или минуты, а не на следующий день.
    purgeIdempotencyKeys().catch((error) => {
      logger.error("Idempotency key purge failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      alerts.report(error, { where: "фоновая чистка ключей идемпотентности" });
    });
  }, intervalMs);
  timer.unref();
  return timer;
}
