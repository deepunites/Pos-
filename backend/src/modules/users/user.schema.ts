import { z } from "zod";
import { booleanQuery, limitQuery, pageQuery } from "../common.schema.js";

export const ROLES = ["admin", "manager", "cashier", "waiter", "kitchen"] as const;

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Пароль не короче 8 символов"),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().max(32).optional(),
  // Short numeric code for signing in at the terminal; stored hashed.
  pin: z
    .string()
    .regex(/^\d{4,10}$/, "PIN — от 4 до 10 цифр")
    .optional()
    .or(z.literal("")),
  role: z.enum(ROLES),
  isActive: z.boolean().optional(),
  // Права кассира — см. users/permissions.ts.
  canSellOnDebt: z.boolean().optional(),
  canReceiveStock: z.boolean().optional(),
  canSeeExpectedCash: z.boolean().optional(),
});

export const updateUserSchema = createUserSchema.omit({ password: true }).partial().extend({
  password: z.string().min(8, "Пароль не короче 8 символов").optional(),
});

export const userQuerySchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(ROLES).optional(),
  isActive: booleanQuery.optional(),
  page: pageQuery,
  limit: limitQuery,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserQueryInput = z.infer<typeof userQuerySchema>;
