import { z } from "zod";
import { booleanQuery, limitQuery, pageQuery } from "../common.schema.js";

// Product fields that are nullable in the DB round-trip as `null` (not
// `undefined`) once the record has been saved and re-fetched by the edit
// form. Plain `.optional()` only accepts `undefined`, so re-submitting a
// product that has any of these unset failed validation ("Expected
// string/number, received null") and silently blocked every save. An
// empty form input ("") is normalized to `null` too, so clearing a field
// in the edit form actually clears it in the DB instead of being dropped.
const blankToNull = (v: unknown) => (v === "" ? null : v);
const optionalString = () => z.preprocess(blankToNull, z.string().nullish());
const optionalUuid = () => z.preprocess(blankToNull, z.string().uuid().nullish());
const optionalNumber = () => z.preprocess(blankToNull, z.number().nullish());
const optionalPositiveNumber = () => z.preprocess(blankToNull, z.number().positive().nullish());

const techCardItemSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  grossWeight: z.number().positive().optional(),
  netWeight: z.number().positive().optional(),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  description: optionalString(),
  categoryId: optionalUuid(),
  sku: optionalString(),
  barcode: optionalString(),
  price: z.number().min(0),
  costPrice: z.number().min(0).optional(),
  compareAtPrice: optionalNumber(),
  taxRate: z.number().min(0).max(100).optional(),
  unit: z.string().optional(),
  purchaseUnit: optionalString(),
  saleUnit: optionalString(),
  conversionFactor: optionalPositiveNumber(),
  minStock: z.number().min(0).optional(),
  currentStock: z.number().min(0).optional(),
  trackInventory: z.boolean().optional(),
  isIngredient: z.boolean().optional(),
  techCardId: optionalUuid(),
  techCard: z.array(techCardItemSchema).optional(),
  preparationArea: optionalString(),
  cookingMethod: optionalString(),
  noDiscounts: z.boolean().optional(),
  imageUrl: optionalString(),
  tags: z.array(z.string()).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const productQuerySchema = z.object({
  search: z.string().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  isActive: booleanQuery.optional(),
  isIngredient: booleanQuery.optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  inStock: booleanQuery.optional(),
  // Sold by weight (per gram or per kilogram) — the terminal's «Весовые» tab.
  weighted: booleanQuery.optional(),
  // Goods with no barcode at all (bread, produce) — the fallback set of
  // one-tap keys when the admin has not marked any.
  noBarcode: booleanQuery.optional(),
  // Products carrying a tag, e.g. "quick" for the register's one-tap keys.
  tag: z.string().max(50).optional(),
  sort: z.enum(["name", "price", "createdAt", "sortOrder"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: pageQuery,
  limit: limitQuery,
});

// One product by what the scanner read: barcode, or the short code (SKU/PLU)
// typed on the keypad. Exact match only.
// ?ids=a,b,c — до сотни товаров за раз (строки прихода).
export const lastSupplyQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => v.split(",").map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});

export const productLookupSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQueryInput = z.infer<typeof productQuerySchema>;
