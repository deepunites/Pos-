import type { Prisma } from "@prisma/client";
import type { StockReceiptQueryInput } from "../common.schema.js";
import prisma from "../../config/database.js";
import { ci } from "../../utils/search.js";
import type { CreateStockReceiptInput } from "./stock-receipt.schema.js";
import { optionalDateFilter, tenantTimeZone } from "../../utils/dates.js";
import { AppError, NotFoundError } from "../../utils/errors.js";
import { lockStockRows, round2, roundStock } from "../inventory/stock.helpers.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";

function computeSalePrice(costPrice: number, markupPercent: number): number {
  const price = costPrice * (1 + markupPercent / 100);
  return Math.round(price * 100) / 100;
}

/**
 * Decides what a receipt line does to the product's sale price.
 *
 * A markup of 0% is not a markup — it is an unconfigured one, and
 * `cost × (1 + 0/100)` is exactly the cost. Repricing from it silently turned
 * every shelf price into the purchase price, so the shop sold at zero margin
 * after a few deliveries. Now a price is only ever written when it is known:
 * an explicit one from the form, or a real (> 0) markup. Otherwise the caller
 * is told what is missing instead of the margin quietly disappearing.
 *
 * Returns the new price, or null when the current price must be left alone.
 */
function resolveSalePrice(
  item: { costPrice: number; updateSalePrice: boolean; salePrice?: number },
  context: { productName: string; markupPercent: number; isNewProduct: boolean }
): number | null {
  if (item.salePrice !== undefined && item.salePrice !== null) return item.salePrice;

  const hasMarkup = context.markupPercent > 0;
  if (item.updateSalePrice && hasMarkup) return computeSalePrice(item.costPrice, context.markupPercent);

  if (context.isNewProduct || item.updateSalePrice) {
    throw new AppError(
      `«${context.productName}»: наценка категории 0% — укажите цену продажи или задайте наценку категории`
    );
  }

  return null;
}

const INVOICE_PREFIX = "ПР-";

/** Следующий номер накладной заведения: «ПР-0043». Номера поставщиков не мешают — считаются только свои. */
export async function nextInvoiceNumber(db: Pick<typeof prisma, "$queryRaw">, tenantId: string): Promise<string> {
  const rows = await db.$queryRaw<{ n: number | null }[]>`
    SELECT MAX(CAST(substring(invoice_number from '^ПР-([0-9]+)$') AS INTEGER)) AS n
    FROM stock_receipts
    WHERE tenant_id = ${tenantId} AND invoice_number ~ '^ПР-[0-9]+$'`;
  return `${INVOICE_PREFIX}${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
}

export class StockReceiptService {
  /**
   * Books a delivery: resolves (or creates) every product, writes the receipt
   * document, raises stock and records the movements — all inside one
   * transaction. It used to run as a sequence of separate writes, so a failure
   * half-way through (an unpriceable line, for example) left a receipt
   * document behind with no stock movement against it.
   */
  async create(tenantId: string, userId: string, data: CreateStockReceiptInput, idem?: IdempotencyContext | null) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const defaultMarkup = tenant?.defaultMarkupPercent ?? 0;

    const receiptId = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const newCategoryCache = new Map<string, string>();
      const lines: {
        productId: string;
        quantity: number;
        costPrice: number;
        /** null = leave the current shelf price alone. */
        newPrice: number | null;
      }[] = [];

      for (const item of data.items) {
        let productId = item.productId;
        let createdNow = false;

        if (!productId && item.newProduct) {
          let categoryId = item.newProduct.categoryId;

          if (!categoryId && item.newProduct.newCategoryName) {
            const name = item.newProduct.newCategoryName.trim();
            const key = name.toLowerCase();
            if (newCategoryCache.has(key)) {
              categoryId = newCategoryCache.get(key);
            } else {
              const existing = await tx.category.findFirst({ where: { tenantId, name } });
              categoryId =
                existing?.id ??
                (await tx.category.create({ data: { tenantId, name, markupPercent: defaultMarkup } })).id;
              newCategoryCache.set(key, categoryId);
            }
          } else if (categoryId) {
            const owned = await tx.category.findFirst({ where: { id: categoryId, tenantId } });
            if (!owned) throw new NotFoundError("Категория не найдена");
          }

          const category = categoryId ? await tx.category.findUnique({ where: { id: categoryId } }) : null;
          const markupPercent = category?.markupPercent ?? defaultMarkup;
          const price = resolveSalePrice(
            { costPrice: item.costPrice, updateSalePrice: true, salePrice: item.salePrice },
            { productName: item.newProduct.name.trim(), markupPercent, isNewProduct: true }
          )!;

          // «кг» с кассы или флажок «на вес» — весовой товар: раньше unit «кг»
          // без saleUnit продавался поштучно, хотя пришёл килограммами.
          const weighed = item.newProduct.weighed || ["кг", "kg"].includes((item.newProduct.unit || "").trim().toLowerCase());
          const created = await tx.product.create({
            data: {
              tenantId,
              categoryId,
              name: item.newProduct.name.trim(),
              barcode: item.newProduct.barcode,
              unit: weighed ? "kg" : item.newProduct.unit || "piece",
              saleUnit: weighed ? "кг" : undefined,
              costPrice: item.costPrice,
              price,
              currentStock: 0,
              trackInventory: true,
            },
          });
          productId = created.id;
          createdNow = true;
        }

        if (!productId) throw new AppError("Не указан товар для позиции прихода");

        const product = await tx.product.findFirst({
          where: { id: productId, tenantId },
          include: { category: true },
        });
        if (!product) throw new NotFoundError("Товар не найден");

        const markupPercent = product.category?.markupPercent ?? defaultMarkup;
        lines.push({
          productId,
          quantity: item.quantity,
          costPrice: item.costPrice,
          // A product created by this receipt was just priced above.
          newPrice: createdNow
            ? null
            : resolveSalePrice(
                {
                  costPrice: item.costPrice,
                  updateSalePrice: item.updateSalePrice ?? false,
                  salePrice: item.salePrice,
                },
                { productName: product.name, markupPercent, isNewProduct: false }
              ),
        });
      }

      const totalAmount = round2(lines.reduce((sum, l) => sum + l.quantity * l.costPrice, 0));

      const receipt = await tx.stockReceipt.create({
        data: {
          tenantId,
          userId,
          supplierName: data.supplierName,
          // Пустой номер — следующий по порядку («ПР-0043»).
          invoiceNumber: data.invoiceNumber?.trim() || (await nextInvoiceNumber(tx, tenantId)),
          totalAmount,
          notes: data.notes,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity,
              costPrice: l.costPrice,
              totalCost: round2(l.quantity * l.costPrice),
            })),
          },
        },
      });

      // Остатки пересчитываются под блокировкой строк (см. lockStockRows):
      // без неё приход, совпавший с продажей, перезаписывал её списание —
      // остаток после «100 − 10 продаж + 50 пришло» выходил 141, а не 140.
      // Блокировка берётся только здесь, в конце, чтобы кассы ждали её как
      // можно меньше: разбор строк и создание новых товаров выше идут без неё.
      await lockStockRows(tx, tenantId, lines.map((l) => l.productId));
      for (const line of lines) {
        const current = await tx.product.findUniqueOrThrow({ where: { id: line.productId }, select: { currentStock: true } });
        await tx.product.update({
          where: { id: line.productId },
          data: {
            currentStock: roundStock(current.currentStock + line.quantity),
            costPrice: line.costPrice,
            ...(line.newPrice !== null ? { price: line.newPrice } : {}),
          },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            productId: line.productId,
            type: "in",
            quantity: line.quantity,
            reason: `Приход #${receipt.id.slice(0, 8)}`,
            referenceId: receipt.id,
            userId,
          },
        });
      }

      await attachIdempotencyResource(tx, tenantId, idem, receipt.id);
      return receipt.id;
    // Большой приход (сотни строк, новые товары) не должен упираться в
    // общий таймаут транзакции в 10 с.
    }, { timeout: 30000 });

    return this.findById(tenantId, receiptId);
  }

  async findAll(tenantId: string, query: StockReceiptQueryInput) {
    const { page = 1, limit = 20, dateFrom, dateTo, supplierName } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.StockReceiptWhereInput = { tenantId };
    const createdAt = optionalDateFilter(dateFrom, dateTo, await tenantTimeZone(tenantId));
    if (createdAt) where.createdAt = createdAt;
    if (supplierName) where.supplierName = ci(supplierName);

    const [receipts, total] = await Promise.all([
      prisma.stockReceipt.findMany({
        where,
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, sku: true } },
            },
          },
          user: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.stockReceipt.count({ where }),
    ]);

    return { receipts, total, page, limit };
  }

  async findById(tenantId: string, id: string) {
    const receipt = await prisma.stockReceipt.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true, volume: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!receipt) throw new NotFoundError("Приход не найден");
    return receipt;
  }

  async delete(tenantId: string, id: string, userId?: string) {
    // Reversing a receipt is a stock movement of its own: the decrement is
    // recorded so the movement journal still reconciles with the balance
    // (and is allowed to go negative if the goods were already sold).
    // Всё — в одной транзакции под блокировкой самого прихода и строк товаров:
    // две одновременные отмены одного прихода иначе обе вычли бы его со склада.
    await inTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_receipts WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError("Приход не найден");

      const items = await tx.stockReceiptItem.findMany({ where: { receiptId: id } });
      await lockStockRows(tx, tenantId, items.map((i) => i.productId));
      for (const item of items) {
        const current = await tx.product.findUniqueOrThrow({ where: { id: item.productId }, select: { currentStock: true } });
        await tx.product.update({
          where: { id: item.productId },
          data: { currentStock: roundStock(current.currentStock - item.quantity) },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            productId: item.productId,
            type: "out",
            quantity: item.quantity,
            reason: `Отмена прихода #${id.slice(0, 8)}`,
            referenceId: id,
            userId,
          },
        });
      }
      await tx.stockReceipt.delete({ where: { id } });
    });

    return { message: "Receipt deleted" };
  }
}

export const stockReceiptService = new StockReceiptService();
