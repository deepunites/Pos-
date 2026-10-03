import { z } from "zod";
import { booleanQuery } from "../common.schema.js";

// Телефоны клиентов — узбекские: +998 и девять цифр. Касса шлёт уже
// «+998901234567», но принимаем и «90 123-45-67», и «998901234567».
export function normalizeUzPhone(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("998")) digits = digits.slice(3);
  return digits.length === 9 ? `+998${digits}` : null;
}

const phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeUzPhone(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Телефон: +998 и 9 цифр" });
      return z.NEVER;
    }
    return normalized;
  });

const name = (max: number) => z.string().trim().min(1).max(max);

export const createCustomerSchema = z.object({
  firstName: name(60),
  lastName: name(60).optional(),
  phone,
  phone2: phone.optional(),
});

export const updateCustomerSchema = z.object({
  firstName: name(60).optional(),
  lastName: name(60).nullable().optional(),
  phone: phone.optional(),
  phone2: phone.nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  debtBlocked: z.boolean().optional(),
});

export const customerQuerySchema = z.object({
  search: z.string().trim().max(60).optional(),
  withDebt: booleanQuery.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const repaymentSchema = z.object({
  amount: z.number().positive("Сумма погашения должна быть больше нуля"),
  method: z.enum(["cash", "card"]),
  // Погашение на кассе попадает в её смену; в админке — без смены.
  cashShiftId: z.string().uuid().optional(),
  note: z.string().trim().max(200).optional(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerQueryInput = z.infer<typeof customerQuerySchema>;
export type RepaymentInput = z.infer<typeof repaymentSchema>;
