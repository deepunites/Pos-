import { z } from "zod";
import { importRowSchema } from "../products/product.import.js";

// Новый товар прямо в приходе. Категория — у кафе (по ней кухня и меню);
// у магазина её нет: товар ищут сканером, а не по полкам.
const newProductSchema = z.object({
  name: z.string().trim().min(1),
  categoryId: z.string().uuid().optional(),
  newCategoryName: z.string().trim().min(1).optional(),
  unit: z.string().optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  // Артикул поставщика: по нему следующий приход из файла узнает этот товар.
  sku: z.string().trim().min(1).max(64).optional(),
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

/**
 * Строк в одном приходе — не больше, чем у прихода из файла. Маршрут формы
 * открыт и кассиру: без предела запрос на сотню тысяч строк держал бы
 * транзакцию и соединение из общего пула, пока его не оборвёт таймаут.
 */
export const MAX_RECEIPT_LINES = 2000;

export const createStockReceiptSchema = z.object({
  supplierName: z.string().optional(),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(stockReceiptItemSchema).min(1).max(MAX_RECEIPT_LINES),
});

export type CreateStockReceiptInput = z.infer<typeof createStockReceiptSchema>;

// Приход из Excel/CSV: строки — те же, что у импорта товаров (админка
// разбирает файл одним и тем же кодом); количество — колонка «Остаток» /
// «Количество», себестоимость и цена продажи — как в файле.
export const importStockReceiptSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(MAX_RECEIPT_LINES),
  // false — только проверить и показать, что будет; true — оформить приход.
  apply: z.boolean(),
  supplierName: z.string().optional(),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
});

export type ImportStockReceiptInput = z.infer<typeof importStockReceiptSchema>;
