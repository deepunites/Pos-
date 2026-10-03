import type { Prisma } from "@prisma/client";
import type { PaymentQueryInput } from "../common.schema.js";
import prisma from "../../config/database.js";
import type { CreatePaymentInput } from "./payment.schema.js";
import { deductTechCardIngredients, round2 } from "../inventory/stock.helpers.js";
import { optionalDateFilter, tenantTimeZone } from "../../utils/dates.js";
import { AppError, ConflictError, NotFoundError } from "../../utils/errors.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";
import { lockOrder } from "../orders/order.locks.js";
import { refundDebt } from "../customers/customer.service.js";

export class PaymentService {
  async create(tenantId: string, data: CreatePaymentInput, userId?: string, idem?: IdempotencyContext | null) {
    // Всё — внутри одной транзакции под блокировкой строки заказа. Раньше
    // статус и остаток к оплате проверялись до транзакции, и пять одновременных
    // оплат одного заказа проходили все пять (тест concurrency.test.ts).
    return inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const order = await lockOrder(tx, tenantId, data.orderId);
      if (!order) throw new NotFoundError("Заказ не найден");
      if (order.status === "cancelled") throw new ConflictError("Нельзя оплатить отменённый заказ");
      if (order.status === "completed") throw new ConflictError("Заказ уже оплачен");

      const payments = await tx.payment.findMany({ where: { orderId: data.orderId, status: "completed" } });
      const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = round2(order.total - totalPaid);

      if (data.amount > remaining + 0.01) {
        throw new AppError(`Сумма превышает остаток к оплате ${remaining.toFixed(2)}`);
      }
      if (data.amount < remaining - 0.01 && !data.allowPartial) {
        throw new Error(`Сумма ${data.amount.toFixed(2)} меньше остатка к оплате ${remaining.toFixed(2)}`);
      }

      const completesOrder = totalPaid + data.amount >= order.total - 0.01;

      const payment = await tx.payment.create({
        data: {
          tenantId,
          orderId: data.orderId,
          method: data.method,
          amount: data.amount,
          tipAmount: data.tipAmount || 0,
          transactionId: data.transactionId,
          cardLastFour: data.cardLastFour,
          status: "completed",
          processedAt: new Date(),
        },
      });

      if (completesOrder) {
        await tx.order.update({
          where: { id: data.orderId },
          data: { status: "completed", completedAt: new Date() },
        });

        // The product's own stock was reserved when the order was created;
        // here only the recipe ingredients are written off.
        await deductTechCardIngredients(tx, { tenantId, userId, orderId: data.orderId });

        if (order.tableId) {
          await tx.table.update({
            where: { id: order.tableId },
            data: { status: "available" },
          });
        }
      }

      await attachIdempotencyResource(tx, tenantId, idem, payment.id);
      return payment;
    });
  }

  async findAll(tenantId: string, query: PaymentQueryInput) {
    const { page = 1, limit = 20, method, status, orderId } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.PaymentWhereInput = { tenantId };
    if (method) where.method = method;
    if (status) where.status = status;
    if (orderId) where.orderId = orderId;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          order: { select: { id: true, orderNumber: true, total: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);

    return { payments, total, page, limit };
  }

  async refund(tenantId: string, paymentId: string, reason: string) {
    return inTransaction(async (tx) => {
      const target = await tx.payment.findFirst({ where: { id: paymentId, tenantId }, select: { orderId: true } });
      if (!target) throw new NotFoundError("Платёж не найден");
      // Блокировка заказа — иначе два одновременных возврата одного платежа
      // (или возврат во время оплаты) оба видели бы платёж «completed».
      await lockOrder(tx, tenantId, target.orderId);
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, tenantId, status: "completed" },
        include: { order: { include: { payments: true } } },
      });
      if (!payment) throw new NotFoundError("Платёж не найден");

      // Причину возврата требует refundPaymentSchema, контроллер передаёт её
      // сюда — и до сих пор она терялась: в платёж не писалась, а в журнал
      // аудита не попадала (middleware/audit сохраняет data из ответа, где
      // причины нет). Теперь она лежит в metadata платежа вместе с временем.
      let metadata: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(payment.metadata || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // битый JSON в metadata не должен ломать возврат
      }

      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "refunded",
          metadata: JSON.stringify({
            ...metadata,
            refund: { reason, at: new Date().toISOString() },
          }),
        },
      });

      // Возврат части «в долг»: денег не было, поэтому уменьшается долг клиента.
      if (payment.method === "debt" && payment.order.customerId) {
        await refundDebt(tx, {
          tenantId,
          customerId: payment.order.customerId,
          orderId: payment.orderId,
          amount: payment.amount,
          note: reason,
        });
      }

      const order = payment.order;
      const otherCompletedPayments = order.payments.filter(
        (p) => p.id !== paymentId && p.status === "completed"
      );
      const totalPaidAfterRefund = otherCompletedPayments.reduce((sum, p) => sum + p.amount, 0);

      if (totalPaidAfterRefund < order.total - 0.01 && order.status === "completed") {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "served", completedAt: null },
        });

        if (order.tableId) {
          await tx.table.update({
            where: { id: order.tableId },
            data: { status: "occupied" },
          });
        }
      }

      return updated;
    });
  }

  async getSummary(tenantId: string, dateFrom?: string, dateTo?: string) {
    const where: Prisma.PaymentWhereInput = { tenantId, status: "completed" };
    const createdAt = optionalDateFilter(dateFrom, dateTo, await tenantTimeZone(tenantId));
    if (createdAt) where.createdAt = createdAt;

    const [payments, totalRevenue, totalTips, byMethod] = await Promise.all([
      prisma.payment.findMany({ where }),
      prisma.payment.aggregate({ where, _sum: { amount: true } }),
      prisma.payment.aggregate({ where, _sum: { tipAmount: true } }),
      prisma.payment.groupBy({
        by: ["method"],
        where,
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      totalRevenue: totalRevenue._sum.amount || 0,
      totalTips: totalTips._sum.tipAmount || 0,
      totalTransactions: payments.length,
      byMethod: byMethod.map((m) => ({
        method: m.method,
        total: m._sum.amount || 0,
        count: m._count,
      })),
    };
  }
}

export const paymentService = new PaymentService();
