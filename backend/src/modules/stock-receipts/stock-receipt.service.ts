import { Prisma } from "@prisma/client";
import type { StockReceiptQueryInput } from "../common.schema.js";
import prisma from "../../config/database.js";
import { ci } from "../../utils/search.js";
import type { CreateStockReceiptInput } from "./stock-receipt.schema.js";
import { optionalDateFilter, tenantTimeZone } from "../../utils/dates.js";
import { AppError, NotFoundError } from "../../utils/errors.js";
import { lockStockRows, round2, roundStock, type Tx } from "../inventory/stock.helpers.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";

export function computeSalePrice(costPrice: number, markupPercent: number): number {
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

interface StockWrite {
  productId: string;
  /** На сколько меняется остаток: приход — плюс, отмена прихода — минус. */
  delta: number;
  /** Новая себестоимость; нет — не трогать. */
  costPrice?: number;
  /** Новая цена продажи; null или нет — не трогать. */
  price?: number | null;
  /** Вернуть снятый с продажи товар в продажу. */
  reactivate?: boolean;
}

/**
 * Остатки прихода (или его отмены) — под блокировкой строк товаров (см.
 * lockStockRows): без неё приход, совпавший с продажей, перезаписывал её
 * списание — остаток после «100 − 10 продаж + 50 пришло» выходил 141, а не 140.
 *
 * Под блокировкой — несколько запросов на весь документ: блокировка с
 * чтением остатков, один UPDATE и (у вызывающего) одна вставка движений
 * склада. По три запроса на строку приход из файла на 2000 строк держал
 * блокировку 12–17 с, а продажа этих же товаров ждёт её не дольше таймаута
 * своей транзакции (10 с) — касса получала «Сервер занят».
 */
async function writeStock(tx: Tx, tenantId: string, writes: StockWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const stock = await lockStockRows(tx, tenantId, writes.map((w) => w.productId));
  // Строки одного товара — одна запись, по порядку строк: остаток
  // складывается, себестоимость и цена — последние заданные. Так же выходило,
  // когда строки записывались по одной.
  const rows = new Map<string, { stock: number; cost: number | null; price: number | null; reactivate: boolean }>();
  for (const w of writes) {
    const prev = rows.get(w.productId);
    const current = prev ? prev.stock : stock.get(w.productId);
    if (current === undefined) throw new NotFoundError("Товар не найден");
    rows.set(w.productId, {
      stock: roundStock(current + w.delta),
      cost: w.costPrice ?? prev?.cost ?? null,
      price: w.price ?? prev?.price ?? null,
      reactivate: !!w.reactivate || !!prev?.reactivate,
    });
  }
  const values = [...rows].map(
    ([id, r]) => Prisma.sql`(${id}, ${r.stock}::double precision, ${r.cost}::double precision, ${r.price}::double precision, ${r.reactivate}::boolean)`
  );
  // updated_at — сами: @updatedAt ставит Prisma, а не база. В UTC, как у
  // Prisma, при любом TimeZone сессии.
  await tx.$executeRaw`
    UPDATE products AS p SET
      current_stock = v.stock,
      cost_price = COALESCE(v.cost, p.cost_price),
      price = COALESCE(v.price, p.price),
      is_active = p.is_active OR v.reactivate,
      updated_at = now() AT TIME ZONE 'UTC'
    FROM (VALUES ${Prisma.join(values)}) AS v(id, stock, cost, price, reactivate)
    WHERE p.id = v.id AND p.tenant_id = ${tenantId}`;
}

/** Что create делает сверх прихода из формы — это нужно приходу из файла. */
export interface CreateReceiptOptions {
  /**
   * Снятые с продажи товары, которые приход возвращает в продажу. Приход из
   * файла узнаёт и архивный товар (удалённый, у которого были продажи): без
   * этого остаток записался бы товару, которого нет ни на кассе, ни в «Товарах».
   */
  reactivate?: ReadonlySet<string>;
  /** Таймаут транзакции, мс. По умолчанию 30 с — хватает любому приходу из формы. */
  timeout?: number;
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
  async create(
    tenantId: string,
    userId: string,
    data: CreateStockReceiptInput,
    idem?: IdempotencyContext | null,
    options: CreateReceiptOptions = {}
  ) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const defaultMarkup = tenant?.defaultMarkupPercent ?? 0;

    const receiptId = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const newCategoryCache = new Map<string, string>();
      // Наценка категорий новых товаров — по запросу на категорию, а не на
      // строку: в файле у сотен строк одна и та же «Напитки».
      const markupByCategory = new Map<string, number>();
      const lines: {
        productId: string;
        quantity: number;
        costPrice: number;
        /** null = leave the current shelf price alone. */
        newPrice: number | null;
      }[] = [];

      // Знакомые товары — одним запросом: в приходе из файла их до двух тысяч.
      const knownIds = [...new Set(data.items.flatMap((i) => (i.productId ? [i.productId] : [])))];
      const known = new Map(
        (knownIds.length ? await tx.product.findMany({ where: { tenantId, id: { in: knownIds } }, include: { category: true } }) : []).map(
          (p) => [p.id, p]
        )
      );

      for (const item of data.items) {
        if (item.productId) {
          const product = known.get(item.productId);
          if (!product) throw new NotFoundError("Товар не найден");
          const markupPercent = product.category?.markupPercent ?? defaultMarkup;
          lines.push({
            productId: product.id,
            quantity: item.quantity,
            costPrice: item.costPrice,
            newPrice: resolveSalePrice(
              {
                costPrice: item.costPrice,
                updateSalePrice: item.updateSalePrice ?? false,
                salePrice: item.salePrice,
              },
              { productName: product.name, markupPercent, isNewProduct: false }
            ),
          });
          continue;
        }

        if (!item.newProduct) throw new AppError("Не указан товар для позиции прихода");

        let categoryId = item.newProduct.categoryId;
        if (!categoryId && item.newProduct.newCategoryName) {
          const name = item.newProduct.newCategoryName.trim();
          const key = name.toLowerCase();
          categoryId = newCategoryCache.get(key);
          if (!categoryId) {
            // Только среди «полок», без учёта регистра — как ищет приход из
            // файла. Категория ингредиентов техкарт с тем же именем — не та:
            // товар в ней касса не покажет, а наценка у неё своя.
            const category =
              (await tx.category.findFirst({ where: { tenantId, isIngredient: false, name: { equals: name, mode: "insensitive" } } })) ??
              (await tx.category.create({ data: { tenantId, name, markupPercent: defaultMarkup } }));
            categoryId = category.id;
            newCategoryCache.set(key, category.id);
            markupByCategory.set(category.id, category.markupPercent);
          }
        } else if (categoryId && !markupByCategory.has(categoryId)) {
          const owned = await tx.category.findFirst({ where: { id: categoryId, tenantId } });
          if (!owned) throw new NotFoundError("Категория не найдена");
          markupByCategory.set(categoryId, owned.markupPercent);
        }

        const markupPercent = categoryId ? markupByCategory.get(categoryId) ?? defaultMarkup : defaultMarkup;
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
            sku: item.newProduct.sku,
            unit: weighed ? "kg" : item.newProduct.unit || "piece",
            saleUnit: weighed ? "кг" : undefined,
            costPrice: item.costPrice,
            price,
            currentStock: 0,
            trackInventory: true,
          },
        });
        // Цена нового товара уже поставлена выше.
        lines.push({ productId: created.id, quantity: item.quantity, costPrice: item.costPrice, newPrice: null });
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

      // Блокировка строк берётся только здесь, в конце, чтобы кассы ждали её
      // как можно меньше: разбор строк и создание новых товаров выше идут без неё.
      await writeStock(
        tx,
        tenantId,
        lines.map((l) => ({
          productId: l.productId,
          delta: l.quantity,
          costPrice: l.costPrice,
          price: l.newPrice,
          reactivate: options.reactivate?.has(l.productId),
        }))
      );
      await tx.inventoryMovement.createMany({
        data: lines.map((l) => ({
          tenantId,
          productId: l.productId,
          type: "in",
          quantity: l.quantity,
          reason: `Приход #${receipt.id.slice(0, 8)}`,
          referenceId: receipt.id,
          userId,
        })),
      });

      await attachIdempotencyResource(tx, tenantId, idem, receipt.id);
      return receipt.id;
    // Большой приход (сотни строк, новые товары) не должен упираться в общий
    // таймаут транзакции в 10 с. Дольше 30 с — только приход из файла, и то с
    // верхней границей (options.timeout): ручной маршрут открыт и кассиру, и
    // клиент не должен сам задавать, сколько транзакция держит соединение.
    }, { timeout: options.timeout ?? 30000 });

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
      // Как и при проведении — несколько запросов на весь приход: отмена
      // прихода из файла на 2000 строк по запросу на строку не укладывалась
      // в таймаут транзакции.
      await writeStock(tx, tenantId, items.map((i) => ({ productId: i.productId, delta: -i.quantity })));
      await tx.inventoryMovement.createMany({
        data: items.map((item) => ({
          tenantId,
          productId: item.productId,
          type: "out",
          quantity: item.quantity,
          reason: `Отмена прихода #${id.slice(0, 8)}`,
          referenceId: id,
          userId,
        })),
      });
      await tx.stockReceipt.delete({ where: { id } });
    });

    return { message: "Receipt deleted" };
  }
}

export const stockReceiptService = new StockReceiptService();
