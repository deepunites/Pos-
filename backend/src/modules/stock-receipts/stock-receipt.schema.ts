import { z } from "zod";

// Новый товар прямо в приходе. Категория — у кафе (по ней кухня и меню);
// у магазина её нет: товар ищут сканером, а не по полкам.
const newProductSchema = z.object({
  name: z.string().trim().min(1),
  categoryId: z.string().uuid().optional(),
  newCategoryName: z.string().trim().min(1).optional(),
  unit: z.string().optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  // На вес: цена и остаток — за килограмм, кассир вводит вес.
  weighed: z.boolean().optional(),
});

const stockReceiptItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    newProduct: newProductSchema.optional(),
    quantity: z.number().positive(),
    costPrice: z.number().min(0),
    // Recomputing the sale price from cost × markup is opt-in: a receipt must
    // not silently reprice goods that are already on the menu. New products
    // created by the receipt always get a computed price.
    updateSalePrice: z.boolean().optional(),
    salePrice: z.number().min(0).optional(),
  })
  .refine((d) => !!d.productId || !!d.newProduct, {
    message: "Укажите productId или newProduct",
  });

export const createStockReceiptSchema = z.object({
  supplierName: z.string().optional(),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(stockReceiptItemSchema).min(1),
});

export type CreateStockReceiptInput = z.infer<typeof createStockReceiptSchema>;
