import { z } from "zod";
import { limitQuery, pageQuery } from "../common.schema.js";

// Prices are never taken from the client. For weighted products (sold by
// gram) the client sends the portion weight in `grams`; the server prices it as
// rate × grams. `unitPrice` is ignored — except in an offline sale (see
// checkoutSchema.offline), where it is the price the customer already paid.
const orderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().min(0).optional(),
  grams: z.number().positive().optional(),
  notes: z.string().optional(),
  modifierIds: z.array(z.string().uuid()).optional(),
});

export const createOrderSchema = z.object({
  branchId: z.string().uuid().optional(),
  tableId: z.string().uuid().optional(),
  cashShiftId: z.string().uuid().optional(),
  type: z.enum(["dine_in", "takeaway", "delivery", "online"]),
  items: z.array(orderItemSchema).min(1, "At least one item required"),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  notes: z.string().optional(),
  discountAmount: z.number().min(0).optional(),
});

// Касса продаёт без связи не дольше двух суток, но чек может дойти и позже
// (планшет лежал выключенным). Дальше — уже не задержка, а мусор.
export const OFFLINE_SALE_MAX_AGE_DAYS = 30;

// One-shot sale from the terminal: order + full payment in a single
// transaction. `expectedTotal` is what the cashier saw and collected; if the
// server's price differs, the whole thing is rejected (409) rather than
// accepting an underpayment.
export const checkoutSchema = createOrderSchema
  .extend({
    expectedTotal: z.number().min(0),
    payment: z.object({
      method: z.enum(["cash", "card", "qr", "online", "gift_card"]),
      tipAmount: z.number().min(0).optional(),
      transactionId: z.string().optional(),
      cardLastFour: z.string().length(4).optional(),
    }),
    // Офлайн-режим кассы: продажа пробита без связи и дошла сюда позже. Деньги
    // уже взяты, поэтому сервер с кассой не спорит: цена — та, по которой
    // продали (unitPrice строки), остатка может не хватить (склад уходит в
    // минус, заказ помечается), смена может быть уже закрыта, товар — снят с
    // продажи. Только наличные: картой и по QR без связи не платят.
    offline: z
      .object({
        soldAt: z.coerce.date(),
        // Кто пробил: чек может дойти, когда на кассе вошёл уже другой кассир.
        cashierId: z.string().uuid().optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.offline) return;
    if (data.payment.method !== "cash") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payment", "method"], message: "Без связи принимаются только наличные" });
    }
    if (data.items.some((item) => item.unitPrice === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "В офлайн-продаже у каждой строки должна быть цена, по которой продали" });
    }
    const now = Date.now();
    const soldAt = data.offline.soldAt.getTime();
    if (soldAt > now + 5 * 60_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offline", "soldAt"], message: "Время продажи в будущем — проверьте часы на кассе" });
    }
    if (soldAt < now - OFFLINE_SALE_MAX_AGE_DAYS * 24 * 3600_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offline", "soldAt"], message: `Офлайн-продажа старше ${OFFLINE_SALE_MAX_AGE_DAYS} дней не принимается` });
    }
  });

// Отмены здесь нет: она возвращает резерв на склад и освобождает стол, а простая
// смена статуса этого не делает. Отменяют через POST /orders/:id/cancel.
export const updateOrderStatusSchema = z.object({
  status: z.enum(["confirmed", "preparing", "ready", "served", "completed"]),
});

// Шаги кухни. served — выдан, заказ уходит с экрана; назад можно на любой шаг
// (повар нажал «Готово» не на той карточке).
export const KITCHEN_STATUSES = ["new", "cooking", "ready", "served"] as const;
export const kitchenStatusSchema = z.object({
  status: z.enum(KITCHEN_STATUSES),
});

export const orderQuerySchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  branchId: z.string().uuid().optional(),
  tableId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(["createdAt", "total", "orderNumber"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: pageQuery,
  limit: limitQuery,
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type KitchenStatusInput = z.infer<typeof kitchenStatusSchema>;
export type OrderQueryInput = z.infer<typeof orderQuerySchema>;
