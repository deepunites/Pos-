import { z } from "zod";
import prisma from "../../config/database.js";
import { inTransaction } from "../../utils/transaction.js";
import { lockStockRows, roundStock, round2, type Tx } from "../inventory/stock.helpers.js";

// Импорт товаров из Excel/CSV — своей выгрузки, шаблона или файла другой
// программы (1С и др.). Файл разбирает админка и присылает строки уже по
// нашим полям; числа приходят как в ячейке («9 000», «13000,50») — разбирает
// сервер, чтобы и проверка, и запись видели одно и то же.
//
// Товар ищется по штрихкоду, потом по артикулу: нашёлся — обновляется тем,
// что есть в строке; нет — создаётся. Остаток ставится как в файле, разница
// пишется в движения склада с пометкой «Импорт»; пустая ячейка — не трогать.

const cell = z.union([z.string(), z.number()]).optional().nullable();

export const importRowSchema = z.object({
  row: z.number().int().positive(),
  name: cell,
  barcode: cell,
  sku: cell,
  category: cell,
  unit: cell,
  price: cell,
  costPrice: cell,
  stock: cell,
  minStock: cell,
});

export const importProductsSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(10_000),
  // false — только проверить и показать, что будет; true — записать.
  apply: z.boolean(),
});

export type ImportRow = z.infer<typeof importRowSchema>;

export type ImportKind = "create" | "update" | "same" | "error";

export interface ImportChange {
  field: "name" | "barcode" | "sku" | "category" | "unit" | "price" | "costPrice" | "stock" | "minStock";
  from: string | number | null;
  to: string | number | null;
}

export interface ImportItem {
  row: number;
  kind: ImportKind;
  name: string;
  message?: string;
  changes: ImportChange[];
}

export interface ImportResult {
  applied: boolean;
  summary: { create: number; update: number; same: number; error: number; priceChanged: number; stockChanged: number };
  /** Ошибки первыми, затем изменения; не больше 500 строк. */
  items: ImportItem[];
}

const MAX_ITEMS = 500;
const BATCH = 200;
const EPS = 0.0005;

const text = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? undefined : s;
};

/** «9 000», «13 000,50», «1.234,5», 9000 → число; пусто → undefined; мусор → NaN. */
export function parseAmount(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v).replace(/[\s  ]/g, "").replace(/(сўм|сум|руб|₽|\$|so'm)/gi, "");
  if (s === "") return undefined;
  // «1.234,5» — точка тысяч, запятая дроби; «1,234.5» — наоборот.
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Весовой ли товар по единице из файла: «кг», «kg», «килограмм». Пусто — неизвестно. */
export function weighedUnit(v: unknown): boolean | undefined {
  const s = text(v)?.toLowerCase().replace(/\.$/, "");
  if (!s) return undefined;
  return /^(кг|kg|кило|килограмм\w*)$/.test(s);
}

/** Ключ штрихкода для сравнения: «054881005500» и «54881005500» — один товар (UPC-A и EAN-13). */
const barcodeKey = (code: string): string => (/^\d+$/.test(code) ? code.replace(/^0+/, "") : code.toLowerCase());

type ExistingProduct = {
  id: string;
  name: string;
  barcode: string | null;
  sku: string | null;
  price: number;
  costPrice: number;
  currentStock: number;
  minStock: number;
  trackInventory: boolean;
  saleUnit: string | null;
  categoryId: string | null;
  isActive: boolean;
};

interface Planned extends ImportItem {
  product?: ExistingProduct;
  data: {
    name?: string;
    barcode?: string;
    sku?: string;
    category?: string;
    weighed?: boolean;
    price?: number;
    costPrice?: number;
    stock?: number;
    minStock?: number;
  };
}

export async function importProducts(tenantId: string, userId: string, rows: ImportRow[], apply: boolean): Promise<ImportResult> {
  const existing: ExistingProduct[] = await prisma.product.findMany({
    where: { tenantId, isIngredient: false },
    select: {
      id: true,
      name: true,
      barcode: true,
      sku: true,
      price: true,
      costPrice: true,
      currentStock: true,
      minStock: true,
      trackInventory: true,
      saleUnit: true,
      categoryId: true,
      isActive: true,
    },
    // Активные — после архивных: при одинаковом штрихкоде в карте останется активный.
    orderBy: { isActive: "asc" },
  });
  const byBarcode = new Map<string, ExistingProduct>();
  const bySku = new Map<string, ExistingProduct>();
  for (const p of existing) {
    if (p.barcode) byBarcode.set(barcodeKey(p.barcode), p);
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
  }
  const categories = await prisma.category.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const categoryById = new Map(categories.map((c) => [c.id, c.name]));
  const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));

  const seenBarcode = new Map<string, number>();
  const seenSku = new Map<string, number>();
  // Один товар — одна строка файла: иначе вторая молча перезапишет первую.
  const seenProduct = new Map<string, number>();
  const plan: Planned[] = rows.map((r) => {
    const name = text(r.name);
    const barcode = text(r.barcode)?.replace(/\s/g, "");
    const sku = text(r.sku);
    const category = text(r.category);
    const weighed = weighedUnit(r.unit);
    const nums = { price: parseAmount(r.price), costPrice: parseAmount(r.costPrice), stock: parseAmount(r.stock), minStock: parseAmount(r.minStock) };
    const fail = (message: string): Planned => ({ row: r.row, kind: "error", name: name ?? "", message, changes: [], data: {} });

    const labels = { price: "цена продажи", costPrice: "себестоимость", stock: "остаток", minStock: "мин. остаток" } as const;
    for (const [field, value] of Object.entries(nums) as [keyof typeof nums, number | undefined][]) {
      if (value === undefined) continue;
      if (Number.isNaN(value)) return fail(`${labels[field]} «${text(r[field])}» — не число`);
      if (value < 0) return fail(`${labels[field]} меньше нуля`);
    }

    if (barcode) {
      const key = barcodeKey(barcode);
      const earlier = seenBarcode.get(key);
      if (earlier) return fail(`штрихкод ${barcode} уже в строке ${earlier}`);
      seenBarcode.set(key, r.row);
    }
    if (sku) {
      const earlier = seenSku.get(sku.toLowerCase());
      if (earlier) return fail(`артикул ${sku} уже в строке ${earlier}`);
      seenSku.set(sku.toLowerCase(), r.row);
    }

    const product = (barcode && byBarcode.get(barcodeKey(barcode))) || (sku && bySku.get(sku.toLowerCase())) || undefined;
    const data = { name, barcode, sku, category, weighed, ...nums };

    if (!product) {
      if (!name) return fail("нет названия");
      if (nums.price === undefined) return fail("нет цены продажи");
      return { row: r.row, kind: "create", name, changes: [], data };
    }

    const earlierRow = seenProduct.get(product.id);
    if (earlierRow) return fail(`этот товар уже в строке ${earlierRow}`);
    seenProduct.set(product.id, r.row);

    // Штрихкод/артикул из строки не должен оказаться у другого товара.
    const otherByBarcode = barcode ? byBarcode.get(barcodeKey(barcode)) : undefined;
    if (otherByBarcode && otherByBarcode.id !== product.id) return fail(`штрихкод ${barcode} уже у товара «${otherByBarcode.name}»`);
    const otherBySku = sku ? bySku.get(sku.toLowerCase()) : undefined;
    if (otherBySku && otherBySku.id !== product.id) return fail(`артикул ${sku} уже у товара «${otherBySku.name}»`);

    const changes: ImportChange[] = [];
    if (name && name !== product.name) changes.push({ field: "name", from: product.name, to: name });
    // Excel съедает ведущий ноль («054881005500» → «54881005500») — это тот же
    // штрихкод, и правильный в базе им не перезаписываем.
    if (barcode && (!product.barcode || barcodeKey(barcode) !== barcodeKey(product.barcode))) {
      changes.push({ field: "barcode", from: product.barcode, to: barcode });
    }
    if (sku && sku.toLowerCase() !== product.sku?.toLowerCase()) changes.push({ field: "sku", from: product.sku, to: sku });
    const currentCategory = product.categoryId ? categoryById.get(product.categoryId) ?? null : null;
    if (category && category.toLowerCase() !== currentCategory?.trim().toLowerCase()) changes.push({ field: "category", from: currentCategory, to: category });
    const isWeighed = ["кг", "kg"].includes((product.saleUnit ?? "").toLowerCase());
    if (weighed !== undefined && weighed !== isWeighed) changes.push({ field: "unit", from: isWeighed ? "кг" : "шт", to: weighed ? "кг" : "шт" });
    if (nums.price !== undefined && Math.abs(nums.price - product.price) > EPS) changes.push({ field: "price", from: product.price, to: round2(nums.price) });
    if (nums.costPrice !== undefined && Math.abs(nums.costPrice - product.costPrice) > EPS) changes.push({ field: "costPrice", from: product.costPrice, to: round2(nums.costPrice) });
    if (nums.minStock !== undefined && Math.abs(nums.minStock - product.minStock) > EPS) changes.push({ field: "minStock", from: product.minStock, to: roundStock(nums.minStock) });
    if (nums.stock !== undefined && (Math.abs(nums.stock - product.currentStock) > EPS || !product.trackInventory)) {
      changes.push({ field: "stock", from: product.trackInventory ? roundStock(product.currentStock) : null, to: roundStock(nums.stock) });
    }
    return { row: r.row, kind: changes.length ? "update" : "same", name: product.name, product, changes, data };
  });

  const summary = {
    create: plan.filter((p) => p.kind === "create").length,
    update: plan.filter((p) => p.kind === "update").length,
    same: plan.filter((p) => p.kind === "same").length,
    error: plan.filter((p) => p.kind === "error").length,
    priceChanged: plan.filter((p) => p.changes.some((c) => c.field === "price")).length,
    stockChanged: plan.filter((p) => p.changes.some((c) => c.field === "stock")).length,
  };
  const order: Record<ImportKind, number> = { error: 0, update: 1, create: 2, same: 3 };
  const items = [...plan]
    .sort((a, b) => order[a.kind] - order[b.kind] || a.row - b.row)
    .slice(0, MAX_ITEMS)
    .map(({ row, kind, name, message, changes }) => ({ row, kind, name, message, changes }));

  if (!apply) return { applied: false, summary, items };

  // Новые категории — один раз на имя, до товаров.
  for (const p of plan) {
    const name = p.kind === "create" || p.changes.some((c) => c.field === "category") ? p.data.category : undefined;
    if (!name || categoryByName.has(name.toLowerCase())) continue;
    const created = await prisma.category.create({ data: { tenantId, name } });
    categoryByName.set(name.toLowerCase(), created.id);
  }

  const work = plan.filter((p) => p.kind === "create" || p.kind === "update");
  for (let i = 0; i < work.length; i += BATCH) {
    const batch = work.slice(i, i + BATCH);
    await inTransaction(async (tx) => {
      const stockIds = batch.filter((p) => p.product && p.changes.some((c) => c.field === "stock")).map((p) => p.product!.id);
      if (stockIds.length) await lockStockRows(tx, tenantId, stockIds);
      for (const p of batch) {
        if (p.kind === "create") await createProduct(tx, tenantId, userId, p, categoryByName);
        else await updateProduct(tx, tenantId, userId, p, categoryByName);
      }
    });
  }

  return { applied: true, summary, items };
}

function categoryId(p: Planned, categoryByName: Map<string, string>): string | undefined {
  return p.data.category ? categoryByName.get(p.data.category.toLowerCase()) : undefined;
}

async function createProduct(tx: Tx, tenantId: string, userId: string, p: Planned, categoryByName: Map<string, string>) {
  const d = p.data;
  const stock = d.stock !== undefined ? roundStock(d.stock) : undefined;
  const created = await tx.product.create({
    data: {
      tenantId,
      name: d.name!,
      barcode: d.barcode,
      sku: d.sku,
      categoryId: categoryId(p, categoryByName),
      unit: d.weighed ? "kg" : "piece",
      saleUnit: d.weighed ? "кг" : undefined,
      price: round2(d.price ?? 0),
      costPrice: round2(d.costPrice ?? 0),
      minStock: d.minStock !== undefined ? roundStock(d.minStock) : 0,
      trackInventory: stock !== undefined,
      currentStock: stock ?? 0,
    },
  });
  if (stock) {
    await tx.inventoryMovement.create({ data: { tenantId, productId: created.id, type: "in", quantity: stock, reason: "Импорт", userId } });
  }
}

async function updateProduct(tx: Tx, tenantId: string, userId: string, p: Planned, categoryByName: Map<string, string>) {
  const product = p.product!;
  const has = (field: ImportChange["field"]) => p.changes.some((c) => c.field === field);
  const d = p.data;
  const data: Record<string, unknown> = {};
  if (has("name")) data.name = d.name;
  if (has("barcode")) data.barcode = d.barcode;
  if (has("sku")) data.sku = d.sku;
  if (has("category")) data.categoryId = categoryId(p, categoryByName);
  if (has("unit")) Object.assign(data, d.weighed ? { unit: "kg", saleUnit: "кг" } : { unit: "piece", saleUnit: null });
  if (has("price")) data.price = round2(d.price!);
  if (has("costPrice")) data.costPrice = round2(d.costPrice!);
  if (has("minStock")) data.minStock = roundStock(d.minStock!);
  if (has("stock")) {
    // Остаток читается заново под блокировкой: продажа могла пройти после проверки.
    const fresh = await tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { currentStock: true, trackInventory: true } });
    const target = roundStock(d.stock!);
    const diff = roundStock(target - (fresh.trackInventory ? fresh.currentStock : 0));
    data.currentStock = target;
    data.trackInventory = true;
    if (Math.abs(diff) > EPS) {
      await tx.inventoryMovement.create({
        data: { tenantId, productId: product.id, type: diff > 0 ? "in" : "out", quantity: Math.abs(diff), reason: "Импорт", userId },
      });
    }
  }
  await tx.product.update({ where: { id: product.id }, data });
}

/** Все товары заведения для выгрузки в Excel/CSV (без ингредиентов техкарт). */
export async function exportProducts(tenantId: string) {
  const products = await prisma.product.findMany({
    where: { tenantId, isIngredient: false },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      name: true,
      barcode: true,
      sku: true,
      saleUnit: true,
      price: true,
      costPrice: true,
      currentStock: true,
      minStock: true,
      trackInventory: true,
      isActive: true,
      metadata: true,
      category: { select: { name: true } },
    },
  });
  return products.map((p) => {
    let ikpu: string | null = null;
    try {
      const value = JSON.parse(p.metadata || "{}").ikpu;
      ikpu = typeof value === "string" ? value : null;
    } catch {
      // битая metadata — без ИКПУ
    }
    return {
      name: p.name,
      barcode: p.barcode,
      sku: p.sku,
      category: p.category?.name ?? null,
      unit: ["кг", "kg"].includes((p.saleUnit ?? "").toLowerCase()) ? "кг" : "шт",
      price: p.price,
      costPrice: p.costPrice,
      stock: p.trackInventory ? roundStock(p.currentStock) : null,
      minStock: p.minStock,
      active: p.isActive,
      ikpu,
    };
  });
}
