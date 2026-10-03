import type { CartItem, Product } from "../../types";
import { productEmoji } from "../../utils/emoji";
import { gramsPerUnit, pricePerKg, stockInKg, weightUnitOf, type WeightUnit } from "../../utils/weight";

export const productTitle = (p: Pick<Product, "name" | "volume">): string => (p.volume ? `${p.name} (${p.volume})` : p.name);

export const emojiFor = (p: Product): string => productEmoji(p.name, p.category?.name);

export const weightUnit = (p: Pick<Product, "saleUnit">): WeightUnit | null => weightUnitOf(p.saleUnit);

/** "84,2" / "12" — one decimal at most, comma like everywhere else on screen. */
export function formatQty(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
}

/**
 * What is still on the shelf, in the product's own stock unit (pieces, grams
 * or kilograms), after what the cart already holds. Infinity when stock is not
 * tracked. `excludeLineId` leaves out the line being edited.
 */
export function stockLeft(p: Product, items: CartItem[], excludeLineId?: string): number {
  if (!p.trackInventory) return Number.POSITIVE_INFINITY;
  const unit = weightUnit(p);
  const inCart = items
    .filter((i) => i.productId === p.id && i.id !== excludeLineId)
    .reduce((sum, i) => (i.grams && unit ? sum + (i.grams * i.quantity) / gramsPerUnit(unit) : sum + i.quantity), 0);
  return Number(p.currentStock) - inCart;
}

/** Shelf price as the cashier reads it: per kilogram for weighed goods, per piece otherwise. */
export function shelfPrice(p: Product): { amount: number; per: string } {
  const unit = weightUnit(p);
  return unit ? { amount: pricePerKg(Number(p.price), unit), per: "кг" } : { amount: Number(p.price), per: "" };
}

/** Stock label for a tile: "84,2 кг" for weighed goods, "24" for pieces; null when not tracked. */
export function stockLabel(p: Product): string | null {
  if (!p.trackInventory) return null;
  const unit = weightUnit(p);
  return unit ? `${formatQty(stockInKg(Number(p.currentStock), unit))} кг` : formatQty(Number(p.currentStock));
}

export type StockState = "ok" | "low" | "out";

export function stockState(p: Product): StockState {
  if (!p.trackInventory) return "ok";
  if (Number(p.currentStock) <= 0) return "out";
  if (Number(p.minStock) > 0 && Number(p.currentStock) <= Number(p.minStock)) return "low";
  return "ok";
}

/**
 * QR на кассе магазина скрыт до доработки (решение владельца, 2026-10-03):
 * кнопки нет, F10 ничего не делает. Оплата по QR в коде остаётся — вернуть её
 * значит поставить здесь true.
 */
export const QR_ENABLED: boolean = false;
