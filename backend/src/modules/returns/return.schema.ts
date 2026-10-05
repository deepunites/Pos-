import { z } from "zod";

// Возврат на кассе: по чеку — строки чека (orderItemId), без чека — товары
// (productId) по текущей цене. Штучный товар — quantity, весовой — grams.
const returnLineSchema = z
  .object({
    orderItemId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    quantity: z.number().int().positive().max(100_000).optional(),
    grams: z.number().positive().max(10_000_000).optional(),
    // Брак: на склад не возвращается.
    defective: z.boolean().optional(),
  })
  .refine((l) => !!l.orderItemId !== !!l.productId, { message: "Укажите строку чека или товар" })
  .refine((l) => !!l.quantity !== !!l.grams, { message: "Укажите количество или вес" });

export const createReturnSchema = z
  .object({
    orderId: z.string().uuid().optional(),
    cashShiftId: z.string().uuid(),
    // Как отдать деньги — решает кассир. В счёт долга — только по чеку клиента.
    method: z.enum(["cash", "card", "debt"]),
    reason: z.string().trim().max(200).optional(),
    items: z.array(returnLineSchema).min(1).max(100),
  })
  .refine((d) => (d.orderId ? d.items.every((i) => i.orderItemId) : d.items.every((i) => i.productId)), {
    message: "По чеку возвращаются строки чека, без чека — товары",
  })
  .refine((d) => d.method !== "debt" || !!d.orderId, { message: "В счёт долга — только по чеку клиента" });

export const saleSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
});

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
