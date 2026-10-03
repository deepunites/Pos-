import { roundStock } from "../inventory/stock.helpers.js";

// Texts of the admin notifications. They used to print the raw status
// ("Статус: completed"), a ruble sign with kopecks whatever the shop's
// currency, and "шт." for everything, kilograms included.

// Same words as the order badges in the admin panel (components/Badge.tsx),
// lower-cased because they stand mid-sentence.
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "ожидает",
  confirmed: "подтверждён",
  preparing: "готовится",
  ready: "готов",
  served: "подан",
  completed: "завершён",
  cancelled: "отменён",
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

// Product.unit holds a key from the settings list (piece, kg, …) or, for goods
// created from a stock receipt on the terminal, the short label itself ("шт",
// "кг"); Product.saleUnit is a short label ("кг", "г"). Both end up here.
const UNIT_SHORT: Record<string, string> = {
  piece: "шт.",
  шт: "шт.",
  "шт.": "шт.",
  kg: "кг",
  кг: "кг",
  g: "г",
  г: "г",
  l: "л",
  л: "л",
  ml: "мл",
  мл: "мл",
  portion: "порц.",
};

export interface TenantUnit {
  key: string;
  label: string;
}

const isTenantUnit = (u: unknown): u is TenantUnit =>
  typeof u === "object" && u !== null && typeof (u as TenantUnit).key === "string" && typeof (u as TenantUnit).label === "string";

/** Units the shop added in Settings → Товары (tenant.settings JSON). */
export function tenantUnits(settings?: string | null): TenantUnit[] {
  try {
    const units: unknown = JSON.parse(settings || "{}")?.units;
    return Array.isArray(units) ? units.filter(isTenantUnit) : [];
  } catch {
    return [];
  }
}

/**
 * The unit stock is counted in. Stock is kept in the sale unit (that is what a
 * sale takes off — stock.helpers.stockUnitsFor), so saleUnit wins over the base
 * unit; a product with neither is counted in pieces.
 */
export function stockUnitOf(
  product: { saleUnit?: string | null; unit?: string | null },
  customUnits: TenantUnit[] = []
): string {
  const raw = (product.saleUnit || product.unit || "").trim();
  if (!raw) return "шт.";
  return UNIT_SHORT[raw.toLowerCase()] ?? customUnits.find((u) => u.key === raw)?.label ?? raw;
}

/** 82.96000000000001 kg → "82,96 кг"; 3 pieces → "3 шт.". */
export function formatStock(
  product: { currentStock: number; saleUnit?: string | null; unit?: string | null },
  customUnits: TenantUnit[] = []
): string {
  const value = roundStock(Number(product.currentStock) || 0).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return `${value} ${stockUnitOf(product, customUnits)}`;
}
