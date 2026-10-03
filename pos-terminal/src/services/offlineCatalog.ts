import api from "./api";
import { dbGet, dbSet } from "./offlineDb";
import { sessionClaims } from "./session";
import type { Category, Product } from "../types";

/**
 * Каталог на планшете — чтобы без связи сканер и поиск находили товары.
 *
 * Пока связь есть, касса работает как раньше, с сервером: там свежие цены и
 * остатки. Копия каталога обновляется при входе, раз в 10 минут и после
 * отправки офлайн-чеков. Без связи поиск, сканер, плитки и быстрые кнопки
 * берут товары отсюда; остаток в копии уменьшается с каждой офлайн-продажей.
 */

export interface CachedCatalog {
  tenantId: string;
  savedAt: number;
  products: Product[];
  categories: Category[];
}

const PAGE = 200;
let current: CachedCatalog | null = null;
let refreshing: Promise<CachedCatalog | null> | null = null;

const keyFor = (tenantId: string) => `catalog:${tenantId}`;

function tenantOfSession(): string | null {
  const fromToken = sessionClaims()?.tenantId;
  if (fromToken) return fromToken;
  try {
    const raw = localStorage.getItem("pos-user");
    return raw ? ((JSON.parse(raw) as { tenantId?: string }).tenantId ?? null) : null;
  } catch {
    return null;
  }
}

/** Копия каталога из памяти или с планшета; null — её ещё нет. */
export async function loadCatalog(tenantId = tenantOfSession()): Promise<CachedCatalog | null> {
  if (!tenantId) return null;
  if (current?.tenantId === tenantId) return current;
  const saved = await dbGet<CachedCatalog>(keyFor(tenantId));
  current = saved ?? null;
  return current;
}

/** Скачать каталог заново. Без связи ничего не трогает — остаётся прежняя копия. */
export function refreshCatalog(tenantId = tenantOfSession()): Promise<CachedCatalog | null> {
  if (!tenantId) return Promise.resolve(null);
  refreshing ??= (async () => {
    try {
      const products: Product[] = [];
      for (let page = 1; page < 500; page++) {
        const res = await api.get("/products", { params: { page, limit: PAGE, isActive: true, isIngredient: false, sort: "name" } });
        products.push(...(res.data.data as Product[]));
        const pages = res.data.pagination?.totalPages ?? 1;
        if (page >= pages) break;
      }
      const categories = (await api.get("/categories")).data.data as Category[];
      const next: CachedCatalog = { tenantId, savedAt: Date.now(), products, categories };
      current = next;
      await dbSet(keyFor(tenantId), next);
      return next;
    } catch {
      return loadCatalog(tenantId);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ── поиск по копии ──────────────────────────────────────────────────────────

/** Варианты одного штрихкода: UPC-A (12 цифр) и он же в EAN-13 с нулём впереди. */
export function barcodeVariants(code: string): string[] {
  const variants = new Set([code]);
  if (/^\d{12}$/.test(code)) variants.add("0" + code);
  if (/^0\d{12}$/.test(code)) variants.add(code.slice(1));
  return Array.from(variants);
}

/** Как /products/lookup: штрихкод важнее короткого кода (SKU). */
export function findInCatalog(catalog: CachedCatalog | null, code: string): Product | null {
  if (!catalog) return null;
  const codes = new Set(barcodeVariants(code));
  return catalog.products.find((p) => p.barcode && codes.has(p.barcode)) ?? catalog.products.find((p) => p.sku === code) ?? null;
}

/** Как поиск /products: каждое слово — в названии, артикуле или штрихкоде, без учёта регистра. */
export function searchCatalog(catalog: CachedCatalog | null, term: string, limit = 8): Product[] {
  if (!catalog) return [];
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return catalog.products
    .filter((p) => {
      const haystack = `${p.name} ${p.sku ?? ""} ${p.barcode ?? ""}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .slice(0, limit);
}

const WEIGHT_UNITS = new Set(["г", "кг", "g", "kg"]);
const hasTag = (p: Product, tag: string) => {
  try {
    return (JSON.parse(p.tags || "[]") as string[]).includes(tag);
  } catch {
    return false;
  }
};

/** Плитки и быстрые кнопки без связи — те же правила, что у запросов к серверу. */
export function listCatalog(
  catalog: CachedCatalog | null,
  filter: { categoryId?: string; weighted?: boolean; tag?: string; noBarcode?: boolean }
): Product[] {
  if (!catalog) return [];
  return catalog.products.filter((p) => {
    if (filter.categoryId && p.categoryId !== filter.categoryId) return false;
    if (filter.weighted === true && !WEIGHT_UNITS.has(p.saleUnit ?? "")) return false;
    if (filter.weighted === false && WEIGHT_UNITS.has(p.saleUnit ?? "")) return false;
    if (filter.tag && !hasTag(p, filter.tag)) return false;
    if (filter.noBarcode && p.barcode) return false;
    return true;
  });
}

/** Офлайн-продажа: в копии остаток уменьшается, чтобы касса не показывала проданное. */
export async function takeFromCatalog(lines: { productId: string; units: number }[]): Promise<void> {
  const catalog = await loadCatalog();
  if (!catalog) return;
  for (const line of lines) {
    const product = catalog.products.find((p) => p.id === line.productId);
    if (product?.trackInventory) product.currentStock = Math.round((Number(product.currentStock) - line.units) * 1000) / 1000;
  }
  await dbSet(keyFor(catalog.tenantId), catalog);
}

/** Для тестов: забыть копию в памяти. */
export function resetCatalog(): void {
  current = null;
  refreshing = null;
}
