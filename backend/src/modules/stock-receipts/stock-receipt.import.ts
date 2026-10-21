import prisma from "../../config/database.js";
import { AppError } from "../../utils/errors.js";
import type { IdempotencyContext } from "../../utils/idempotency.js";
import { round2, roundStock } from "../inventory/stock.helpers.js";
import { barcodeKey, nameKey, parseAmount, text, weighedUnit, type ImportRow } from "../products/product.import.js";
import type { CreateStockReceiptInput, ImportStockReceiptInput } from "./stock-receipt.schema.js";
import { computeSalePrice, stockReceiptService } from "./stock-receipt.service.js";

// Приход из Excel/CSV: накладная поставщика или своя таблица — название,
// количество («Количество», «Кол-во» или «Остаток»), себестоимость, цена
// продажи, штрихкод, артикул, категория, единица. Один файл — один документ
// прихода на странице «Приходы».
//
// Товар узнаётся так же, как при импорте товаров: по штрихкоду, по артикулу,
// а без них — по названию. Незнакомый создаётся самим приходом. Записывает
// всё stockReceiptService.create — с теми же движениями склада,
// себестоимостью, номером, блокировками строк и одной транзакцией, что у
// прихода из формы. Здесь — только разбор файла и проверка, чтобы владелец
// увидел, что будет (какие товары новые, где меняется цена), до записи.

export interface ReceiptImportItem {
  row: number;
  kind: "existing" | "new" | "error";
  name: string;
  message?: string;
  productId?: string;
  quantity?: number;
  costPrice?: number;
  salePrice?: number | null;
  currentPrice?: number | null;
  priceChanged?: boolean;
  sum?: number;
}

export interface ReceiptImportResult {
  applied: boolean;
  receipt?: { id: string; receiptNumber: string; totalAmount: number };
  summary: { existing: number; new: number; error: number; quantity: number; totalCost: number; totalSale: number };
  /** Ошибки первыми, затем по строкам; не больше 500 строк. */
  items: ReceiptImportItem[];
}

const MAX_ITEMS = 500;

type Line = CreateStockReceiptInput["items"][number];

interface Planned {
  item: ReceiptImportItem;
  /** Строка документа прихода; у строки с ошибкой её нет. */
  line?: Line;
  /** Найден снятый с продажи товар — приход вернёт его в продажу. */
  reactivate?: boolean;
}

type Known = { id: string; name: string; barcode: string | null; sku: string | null; price: number; isActive: boolean };

const LABELS = { stock: "количество", costPrice: "себестоимость", price: "цена продажи" } as const;

// Больше — опечатка или мусор в ячейке, а не поставка: 1e308 проходил
// проверку и уходил в остаток и сумму прихода бесконечностью (в JSON — null,
// и кнопка «Провести приход на …» была с пустой суммой).
const LIMITS = { stock: 1_000_000, costPrice: 1e12, price: 1e12 } as const;

const ARCHIVED = "снят с продажи — вернётся в продажу";

/**
 * Разбор строк файла против товаров заведения. createdHere — товары, которые
 * создал уже записанный приход (ответ на повтор по Idempotency-Key): разбор
 * их не видит, как не видел в первый раз. Иначе строка, создавшая «Cola» со
 * штрихкодом, сделала бы соседнюю «Cola» без кодов ошибкой «несколько», и
 * повтор ответил бы не тем, что первый запрос.
 */
async function plan(tenantId: string, rows: ImportRow[], createdHere: ReadonlySet<string> = new Set()): Promise<Planned[]> {
  const [products, categories, tenant] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId, isIngredient: false },
      select: { id: true, name: true, barcode: true, sku: true, price: true, isActive: true },
      // Активные — после архивных: при одинаковом штрихкоде в карте останется активный.
      orderBy: { isActive: "asc" },
    }),
    // Категории ингредиентов техкарт — не полки: товар в них касса не покажет.
    prisma.category.findMany({ where: { tenantId, isIngredient: false }, select: { id: true, name: true, markupPercent: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultMarkupPercent: true } }),
  ]);
  const defaultMarkup = tenant?.defaultMarkupPercent ?? 0;

  const byBarcode = new Map<string, Known>();
  const bySku = new Map<string, Known>();
  // Хлеб, развес — без штрихкода и артикула: их узнаём по названию, иначе
  // каждый приход из файла заводил бы копию товара.
  const byName = new Map<string, Known[]>();
  for (const p of products) {
    if (createdHere.has(p.id)) continue;
    if (p.barcode) byBarcode.set(barcodeKey(p.barcode), p);
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
    const key = nameKey(p.name);
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const categoryByName = new Map(categories.map((c) => [nameKey(c.name), c]));

  // Один товар — одна строка: вторая строка того же товара — скорее всего
  // ошибка в файле, а молча сложенное количество её бы спрятало.
  const seenProduct = new Map<string, number>();
  // Новые товары — по штрихкоду, артикулу и названию.
  const seenNew = new Map<string, number>();

  return rows.map((r): Planned => {
    const name = text(r.name);
    const barcode = text(r.barcode)?.replace(/\s/g, "");
    const sku = text(r.sku);
    const category = text(r.category);
    const fail = (message: string): Planned => ({ item: { row: r.row, kind: "error", name: name ?? "", message } });

    // Количество — не деньги: «1,5» кг — полтора килограмма, а не 15 тысяч.
    const nums = { stock: parseAmount(r.stock), costPrice: parseAmount(r.costPrice, true), price: parseAmount(r.price, true) };
    for (const field of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
      if (Number.isNaN(nums[field])) return fail(`${LABELS[field]} «${text(r[field])}» — не число`);
      if ((nums[field] ?? 0) > LIMITS[field]) return fail(`${LABELS[field]} «${text(r[field])}» — слишком большое число`);
    }
    if (nums.stock === undefined) return fail("нет количества");
    const quantity = roundStock(nums.stock);
    if (quantity <= 0) return fail("количество должно быть больше нуля");
    if (nums.costPrice === undefined) return fail("нет себестоимости");
    if (nums.costPrice < 0) return fail("себестоимость меньше нуля");
    if (nums.price !== undefined && nums.price < 0) return fail("цена продажи меньше нуля");
    const costPrice = round2(nums.costPrice);
    const salePrice = nums.price !== undefined ? round2(nums.price) : undefined;
    const sum = round2(quantity * costPrice);

    let product = (barcode && byBarcode.get(barcodeKey(barcode))) || (sku && bySku.get(sku.toLowerCase())) || undefined;
    // По названию — только строка без кодов: у строки со штрихкодом, которого
    // нет в базе, это другой товар с тем же названием (другой объём, вкус).
    if (!product && !barcode && !sku && name) {
      const same = byName.get(nameKey(name)) ?? [];
      const active = same.filter((p) => p.isActive);
      const candidates = active.length ? active : same;
      if (candidates.length > 1) return fail(`товаров «${name}» несколько — укажите артикул или штрихкод`);
      product = candidates[0];
    }

    if (product) {
      const earlier = seenProduct.get(product.id);
      if (earlier) return fail(`этот товар уже в строке ${earlier}`);
      seenProduct.set(product.id, r.row);
      // Удалённый товар с продажами в истории не стирается, а снимается с
      // продажи. Пришёл снова — возвращается в продажу (как при импорте
      // товаров): иначе пять бутылок оприходованы, а на кассе их нет.
      const archived = !product.isActive;
      return {
        item: {
          row: r.row,
          kind: "existing",
          name: product.name,
          ...(archived ? { message: ARCHIVED } : {}),
          productId: product.id,
          quantity,
          costPrice,
          salePrice: salePrice ?? null,
          currentPrice: product.price,
          priceChanged: salePrice !== undefined && salePrice !== round2(product.price),
          sum,
        },
        // Цена продажи — только если она есть в файле: create ставит явно
        // заданную цену, а без неё оставляет полочную как есть (не пересчитывает
        // по наценке — updateSalePrice не передаётся).
        line: { productId: product.id, quantity, costPrice, ...(salePrice !== undefined ? { salePrice } : {}) },
        reactivate: archived,
      };
    }

    if (!name) return fail("нет названия");
    if (barcode && barcode.length > 64) return fail("штрихкод длиннее 64 символов");
    if (sku && sku.length > 64) return fail("артикул длиннее 64 символов");
    const codes = [barcode && `b:${barcodeKey(barcode)}`, sku && `s:${sku.toLowerCase()}`].filter((k): k is string => !!k);
    const byNameKey = `n:${nameKey(name)}`;
    const earlier = (codes.length ? codes : [byNameKey]).map((k) => seenNew.get(k)).find((n) => n !== undefined);
    if (earlier) return fail(`этот товар уже в строке ${earlier}`);
    for (const k of [...codes, byNameKey]) if (!seenNew.has(k)) seenNew.set(k, r.row);

    // Без цены в файле create считает её по наценке категории (новой — по
    // наценке заведения), а при нулевой — отказывает весь приход. Здесь то же
    // самое, но заранее и с номером строки.
    const known = category ? categoryByName.get(nameKey(category)) : undefined;
    const markup = known ? known.markupPercent : defaultMarkup;
    const price = salePrice ?? (markup > 0 ? computeSalePrice(costPrice, markup) : undefined);
    if (price === undefined) return fail("нет цены продажи, а наценка категории 0%");

    return {
      item: { row: r.row, kind: "new", name, quantity, costPrice, salePrice: price, currentPrice: null, priceChanged: false, sum },
      line: {
        newProduct: {
          name,
          ...(barcode ? { barcode } : {}),
          ...(sku ? { sku } : {}),
          // Пустая категория — товар без категории, как у прихода из формы
          // (магазин ищет товар сканером, а не по полкам).
          ...(known ? { categoryId: known.id } : category ? { newCategoryName: category } : {}),
          ...(weighedUnit(r.unit) ? { weighed: true } : {}),
        },
        quantity,
        costPrice,
        ...(salePrice !== undefined ? { salePrice } : {}),
      },
    };
  });
}

function summarize(planned: Planned[]): Pick<ReceiptImportResult, "summary" | "items"> {
  const items = planned.map((p) => p.item);
  const valid = items.filter((i) => i.kind !== "error");
  const count = (kind: ReceiptImportItem["kind"]) => items.filter((i) => i.kind === kind).length;
  const summary = {
    existing: count("existing"),
    new: count("new"),
    error: count("error"),
    quantity: roundStock(valid.reduce((s, i) => s + i.quantity!, 0)),
    // Как totalAmount документа в create: сумма количество × себестоимость, округлённая один раз.
    totalCost: round2(valid.reduce((s, i) => s + i.quantity! * i.costPrice!, 0)),
    // В ценах продажи: из файла, а где её нет — полочная.
    totalSale: round2(valid.reduce((s, i) => s + i.quantity! * (i.salePrice ?? i.currentPrice ?? 0), 0)),
  };
  const errorsFirst = (i: ReceiptImportItem) => (i.kind === "error" ? 0 : 1);
  return { summary, items: [...items].sort((a, b) => errorsFirst(a) - errorsFirst(b) || a.row - b.row).slice(0, MAX_ITEMS) };
}

const receiptRef = (receipt: { id: string; invoiceNumber: string | null; totalAmount: number }) => ({
  id: receipt.id,
  receiptNumber: receipt.invoiceNumber ?? "",
  totalAmount: receipt.totalAmount,
});

/** apply=false — только проверка («что будет»); true — один документ прихода через stockReceiptService.create. */
export async function importStockReceipt(
  tenantId: string,
  userId: string,
  data: ImportStockReceiptInput,
  idem?: IdempotencyContext | null
): Promise<ReceiptImportResult> {
  const planned = await plan(tenantId, data.rows);
  const result = summarize(planned);
  if (!data.apply) return { applied: false, ...result };

  // Половина накладной на складе хуже, чем ничего: владелец не вспомнит,
  // какие строки прошли, и загрузит файл ещё раз.
  if (result.summary.error > 0) throw new AppError("В файле есть ошибки — исправьте строки и загрузите снова");
  const items = planned.flatMap((p) => (p.line ? [p.line] : []));
  if (!items.length) throw new AppError("В файле нет строк для прихода");
  const reactivate = new Set(planned.flatMap((p) => (p.reactivate && p.line?.productId ? [p.line.productId] : [])));

  const receipt = await stockReceiptService.create(
    tenantId,
    userId,
    {
      supplierName: text(data.supplierName),
      // Пустой номер — create возьмёт следующий свой («ПР-0043»).
      invoiceNumber: text(data.invoiceNumber),
      notes: data.notes?.trim() || undefined,
      items,
    },
    idem,
    {
      reactivate,
      // Тысяча новых товаров — тысяча вставок: 30 с, как у прихода из формы,
      // может не хватить. Но не дольше двух минут, сколько бы ни было строк.
      timeout: Math.min(120_000, Math.max(30_000, items.length * 60)),
    }
  );
  return { applied: true, receipt: receiptRef(receipt), ...result };
}

/**
 * Ответ на повтор по Idempotency-Key: приход уже записан, второй раз его не
 * оформляем. Строки разбираются заново без товаров, созданных этим приходом
 * (их createdAt не раньше ключа — ключ занимается первой строкой транзакции,
 * claimIdempotencyKey), — те же строки «новые», что и в первом ответе, и те
 * же суммы. Чего база не помнит — состояния до прихода: у повтора currentPrice
 * уже новая (priceChanged — false), а возвращённый в продажу товар уже не
 * помечен «снят с продажи».
 */
export async function replayStockReceiptImport(
  tenantId: string,
  data: ImportStockReceiptInput,
  receiptId: string,
  idem: IdempotencyContext
): Promise<ReceiptImportResult> {
  const receipt = await stockReceiptService.findById(tenantId, receiptId);
  const key = await prisma.idempotencyKey.findUnique({
    where: { tenantId_key: { tenantId, key: idem.key } },
    select: { createdAt: true },
  });
  const created = key
    ? await prisma.product.findMany({
        where: { tenantId, id: { in: receipt.items.map((i) => i.productId) }, createdAt: { gte: key.createdAt } },
        select: { id: true },
      })
    : [];
  const result = summarize(await plan(tenantId, data.rows, new Set(created.map((p) => p.id))));
  return { applied: true, receipt: receiptRef(receipt), ...result };
}
