import type { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";
import { AppError, ConflictError, NotFoundError } from "../../utils/errors.js";
import { gramsPerUnit, lockStockRows, round2, roundStock, type Tx } from "../inventory/stock.helpers.js";
import { lockOrder } from "../orders/order.locks.js";
import { refundDebt } from "../customers/customer.service.js";
import { barcodeVariants } from "../catalog/gtin.js";
import type { CreateReturnInput } from "./return.schema.js";
import { openShiftForMoney } from "../cash-shifts/shift.guard.js";

// Возврат товара на кассе. По чеку: кассир отмечает, какие строки и сколько
// вернули, сумма — доля строки в оплаченном чеке (со скидкой), больше
// проданного не вернуть. Без чека: товар по текущей цене. Деньги — как решил
// кассир: наличными из ящика, на карту или в счёт долга клиента чека. Товар
// возвращается на склад, брак — нет.

const RECENT_DAYS = 3;
const EPS = 0.0005;

interface SoldLine {
  orderItemId: string;
  productId: string;
  name: string;
  /** Весовой товар: всё в граммах; штучный — в штуках. */
  weighed: boolean;
  sold: number;
  returned: number;
  left: number;
  /** Сумма строки в чеке (с долей скидки) и уже возвращённая по ней. */
  lineTotal: number;
  returnedAmount: number;
}

/** Доля оплаченного в строке: скидка на чек делится по строкам пропорционально. */
const discountRatio = (order: { subtotal: number; total: number }) => (order.subtotal > 0 ? order.total / order.subtotal : 1);

async function soldLines(db: Tx | typeof prisma, order: { id: string; subtotal: number; total: number }) {
  const items = await db.orderItem.findMany({
    where: { orderId: order.id },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const returned = await db.saleReturnItem.groupBy({
    by: ["orderItemId"],
    where: { orderItemId: { in: items.map((i) => i.id) } },
    _sum: { quantity: true, weightGrams: true, amount: true },
  });
  const byItem = new Map(returned.map((r) => [r.orderItemId, r._sum]));
  const ratio = discountRatio(order);
  return items.map((i): SoldLine => {
    const weighed = i.weightGrams !== null && i.weightGrams !== undefined;
    const sold = weighed ? i.weightGrams! * i.quantity : i.quantity;
    const back = byItem.get(i.id);
    const returnedQty = weighed ? back?.weightGrams ?? 0 : back?.quantity ?? 0;
    return {
      orderItemId: i.id,
      productId: i.productId,
      name: i.product.name,
      weighed,
      sold,
      returned: returnedQty,
      left: Math.max(0, roundStock(sold - returnedQty)),
      lineTotal: round2(i.totalPrice * ratio),
      returnedAmount: round2(back?.amount ?? 0),
    };
  });
}

function saleView(
  order: Prisma.OrderGetPayload<{ include: { payments: true; customer: true } }>,
  lines: SoldLine[]
) {
  const returnedAmount = round2(lines.reduce((sum, l) => sum + l.returnedAmount, 0));
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    total: order.total,
    returnedAmount,
    payments: order.payments.filter((p) => p.status === "completed").map((p) => ({ method: p.method, amount: p.amount })),
    customer: order.customer
      ? { id: order.customer.id, firstName: order.customer.firstName, lastName: order.customer.lastName, debtBalance: order.customer.debtBalance }
      : null,
    items: lines.map((l) => ({
      orderItemId: l.orderItemId,
      productId: l.productId,
      name: l.name,
      weighed: l.weighed,
      sold: l.sold,
      returned: l.returned,
      left: l.left,
      lineTotal: l.lineTotal,
      // Сколько вернуть за всё, что ещё можно вернуть.
      leftAmount: round2(Math.max(0, l.lineTotal - l.returnedAmount)),
    })),
  };
}

/** Сумма к возврату за часть строки; за весь остаток — ровно остаток суммы, без копеек от округления. */
function lineRefund(line: SoldLine, amount: number): number {
  if (Math.abs(amount - line.left) < EPS) return round2(line.lineTotal - line.returnedAmount);
  return round2((line.lineTotal * amount) / line.sold);
}

/** Номер возврата в точке: 1, 2, 3… Под блокировкой точки, без пропусков. */
async function nextReturnNumber(tx: Tx, tenantId: string): Promise<number> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"sale_returns:" + tenantId}))::text`;
  const last = await tx.saleReturn.aggregate({ where: { tenantId }, _max: { number: true } });
  return (last._max.number ?? 0) + 1;
}

const RETURN_INCLUDE = {
  items: true,
  order: { select: { orderNumber: true } },
  user: { select: { firstName: true, lastName: true } },
} as const;

export const returnService = {
  /** Продажи для возврата: по номеру чека, по товару (название, штрихкод, артикул) или последние за три дня. */
  async findSales(tenantId: string, q?: string) {
    const query = q?.trim().replace(/^№\s*/, "") ?? "";
    const where: Prisma.OrderWhereInput = { tenantId, status: "completed" };
    if (query) {
      const or: Prisma.OrderWhereInput[] = [
        {
          items: {
            some: {
              product: {
                OR: [
                  { name: { contains: query, mode: "insensitive" } },
                  { barcode: { in: barcodeVariants(query) } },
                  { sku: { equals: query, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      ];
      if (/^\d{1,9}$/.test(query)) or.unshift({ orderNumber: Number(query) });
      where.OR = or;
    } else {
      where.createdAt = { gte: new Date(Date.now() - RECENT_DAYS * 24 * 3600_000) };
    }
    const orders = await prisma.order.findMany({
      where,
      include: { payments: true, customer: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return Promise.all(orders.map(async (o) => saleView(o, await soldLines(prisma, o))));
  },

  async findById(tenantId: string, id: string) {
    const found = await prisma.saleReturn.findFirst({ where: { id, tenantId }, include: RETURN_INCLUDE });
    if (!found) throw new NotFoundError("Возврат не найден");
    return found;
  },

  async create(tenantId: string, userId: string, data: CreateReturnInput, idem?: IdempotencyContext | null, role = "cashier") {
    const id = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);

      const shift = await openShiftForMoney(tx, { tenantId, shiftId: data.cashShiftId, userId, role });
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { businessType: true } });
      const retail = tenant?.businessType === "retail";

      const lines: { orderItemId?: string; productId: string; name: string; quantity: number; weightGrams: number | null; units: number; amount: number; defective: boolean }[] = [];
      let customerId: string | null = null;

      if (data.orderId) {
        // Блокировка чека: два одновременных возврата одной строки не вернут больше проданного.
        const locked = await lockOrder(tx, tenantId, data.orderId);
        if (!locked) throw new NotFoundError("Чек не найден");
        const order = await tx.order.findUniqueOrThrow({ where: { id: data.orderId } });
        if (order.status !== "completed") throw new ConflictError("Вернуть можно только по оплаченному чеку");
        customerId = order.customerId;
        const sold = new Map((await soldLines(tx, order)).map((l) => [l.orderItemId, l]));

        for (const item of data.items) {
          const line = sold.get(item.orderItemId!);
          if (!line) throw new NotFoundError("Строки нет в этом чеке");
          const amount = line.weighed ? item.grams : item.quantity;
          if (amount === undefined) throw new AppError(line.weighed ? `«${line.name}»: укажите вес` : `«${line.name}»: укажите количество`);
          if (amount > line.left + EPS) {
            throw new ConflictError(
              line.left > 0
                ? `«${line.name}»: вернуть можно не больше ${line.weighed ? `${roundStock(line.left / 1000)} кг` : `${line.left} шт`}`
                : `«${line.name}» уже вернули`
            );
          }
          const product = await tx.product.findUniqueOrThrow({ where: { id: line.productId }, select: { saleUnit: true } });
          lines.push({
            orderItemId: line.orderItemId,
            productId: line.productId,
            name: line.name,
            quantity: line.weighed ? 1 : amount,
            weightGrams: line.weighed ? amount : null,
            units: line.weighed ? amount / (gramsPerUnit(product.saleUnit) ?? 1) : amount,
            amount: lineRefund(line, amount),
            defective: Boolean(item.defective),
          });
          // Вторая строка возврата по той же строке чека — уже от остатка.
          line.left = roundStock(line.left - amount);
          line.returnedAmount = round2(line.returnedAmount + lines[lines.length - 1].amount);
        }
      } else {
        // Без чека: товар по текущей цене.
        for (const item of data.items) {
          const product = await tx.product.findFirst({ where: { id: item.productId!, tenantId } });
          if (!product) throw new NotFoundError("Товар не найден");
          const per = gramsPerUnit(product.saleUnit);
          if (per !== null && !item.grams) throw new AppError(`«${product.name}»: укажите вес`);
          if (per === null && !item.quantity) throw new AppError(`«${product.name}»: укажите количество`);
          lines.push({
            productId: product.id,
            name: product.name,
            quantity: per !== null ? 1 : item.quantity!,
            weightGrams: per !== null ? item.grams! : null,
            units: per !== null ? item.grams! / per : item.quantity!,
            amount: round2(per !== null ? (product.price * item.grams!) / per : product.price * item.quantity!),
            defective: Boolean(item.defective),
          });
        }
      }

      const amount = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      if (amount <= 0) throw new AppError("Сумма возврата — ноль");

      if (data.method === "debt") {
        if (!customerId) throw new ConflictError("В чеке нет клиента — верните деньгами");
        const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
        if (customer.debtBalance + EPS < amount) {
          throw new ConflictError(`Долг клиента ${round2(customer.debtBalance)} — меньше суммы возврата ${amount}: верните деньгами`);
        }
      }

      const number = await nextReturnNumber(tx, tenantId);
      const created = await tx.saleReturn.create({
        data: {
          tenantId,
          number,
          orderId: data.orderId,
          cashShiftId: shift.id,
          userId,
          method: data.method,
          amount,
          reason: data.reason,
          items: {
            create: lines.map((l) => ({
              orderItemId: l.orderItemId,
              productId: l.productId,
              name: l.name,
              quantity: l.quantity,
              weightGrams: l.weightGrams,
              amount: l.amount,
              defective: l.defective,
            })),
          },
        },
      });

      if (data.method === "debt" && customerId && data.orderId) {
        await refundDebt(tx, { tenantId, customerId, orderId: data.orderId, amount, userId, note: `Возврат №${number}` });
      }

      // Склад: целый товар — обратно в остаток, брак — нет (он уже списан продажей).
      const back = lines.filter((l) => !l.defective);
      if (back.length) {
        await lockStockRows(tx, tenantId, back.map((l) => l.productId));
        for (const l of back) {
          const product = await tx.product.findUniqueOrThrow({ where: { id: l.productId }, select: { currentStock: true, trackInventory: true } });
          if (!product.trackInventory && !retail) continue;
          await tx.product.update({
            where: { id: l.productId },
            data: { currentStock: roundStock(product.currentStock + l.units), trackInventory: true },
          });
          await tx.inventoryMovement.create({
            data: { tenantId, productId: l.productId, type: "in", quantity: roundStock(l.units), reason: `Возврат №${number}`, referenceId: created.id, userId },
          });
        }
      }

      await attachIdempotencyResource(tx, tenantId, idem, created.id);
      return created.id;
    });
    return this.findById(tenantId, id);
  },

  /** Возвраты смены по способу: наличные ушли из ящика, карта — на карту, долг — уменьшен. */
  async shiftTotals(tenantId: string, shiftId: string) {
    const rows = await prisma.saleReturn.groupBy({ by: ["method"], where: { tenantId, cashShiftId: shiftId }, _sum: { amount: true } });
    const sum = (method: string) => round2(rows.find((r) => r.method === method)?._sum.amount ?? 0);
    return { totalReturnsCash: sum("cash"), totalReturnsCard: sum("card"), totalReturnsDebt: sum("debt") };
  },

  /** Сумма возвратов за период — отчёты считают выручку за вычетом их. */
  async sumSince(tenantId: string, from: Date, to?: Date) {
    const r = await prisma.saleReturn.aggregate({ where: { tenantId, createdAt: { gte: from, ...(to ? { lt: to } : {}) } }, _sum: { amount: true } });
    return round2(r._sum.amount ?? 0);
  },
};
