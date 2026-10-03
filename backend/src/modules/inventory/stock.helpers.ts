import { Prisma } from "@prisma/client";

// Everything here runs inside a caller-supplied transaction so that an order,
// its stock movements and its payment either all land or none do.
export type Tx = Prisma.TransactionClient;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// Stock is counted to the gram: kilograms with three decimals. Plain float
// arithmetic would leave 84.2 − 1.24 = 82.96000000000001 in the database and,
// worse, turn "0.3 kg, sell 0.1, then 0.2" into 0.19999999999999998 < 0.2 —
// refusing the very last bit of a product that is in stock. So a new balance
// is rounded when it is written, and "is there enough" tolerates the noise.
export const roundStock = (n: number): number => Math.round(n * 1000) / 1000;
const STOCK_EPSILON = 1e-6;
export const hasEnough = (stock: number, need: number): boolean => stock + STOCK_EPSILON >= need;

// Weighted products are priced and stocked per gram ("г") or per kilogram
// ("кг"). The cart always carries the weight in grams; this says how many grams
// one priced/stocked unit is, or null when the product is not sold by weight.
export function gramsPerUnit(saleUnit?: string | null): number | null {
  switch ((saleUnit || "").trim().toLowerCase()) {
    case "г":
    case "g":
      return 1;
    case "кг":
    case "kg":
      return 1000;
    default:
      return null;
  }
}

// Human label of the unit weighted stock is kept in — for error messages.
export function stockUnitLabel(saleUnit?: string | null): string {
  const per = gramsPerUnit(saleUnit);
  return per === 1000 ? " кг" : per === 1 ? " г" : "";
}

// Stock consumed by one order line. A weighted line of `weightGrams` grams,
// repeated `quantity` times, takes weightGrams × quantity out of stock, in the
// product's own unit (grams or kilograms); everything else takes `quantity`
// pieces. Callers without the unit at hand get grams, as before.
export function stockUnitsFor(
  item: { quantity: number; weightGrams?: number | null },
  saleUnit?: string | null
): number {
  if (!item.weightGrams) return item.quantity;
  const per = gramsPerUnit(saleUnit) ?? 1;
  return (item.weightGrams * item.quantity) / per;
}

/**
 * Блокирует строки товаров до конца транзакции. После неё остаток, прочитанный
 * следующими запросами, — последний зафиксированный, и никакая другая
 * транзакция не изменит его, пока эта не завершится.
 *
 * На SQLite этого не требовалось: писатель в базе один, и «прочитать остаток →
 * проверить → записать» никогда не перемежалось с чужой продажей. На Postgres
 * транзакции идут параллельно, и без блокировки две кассы, пробившие последнюю
 * единицу одновременно, обе прочитали бы «1» и обе продали бы.
 *
 * - Порядок блокировки один для всех (по id, побайтно — COLLATE "C"), иначе две
 *   продажи одних и тех же товаров в разном порядке ждали бы друг друга вечно.
 * - FOR NO KEY UPDATE, а не FOR UPDATE: вставка строк заказа и движений склада
 *   со ссылкой на товар берёт на нём KEY SHARE, и FOR UPDATE с ней конфликтовал
 *   бы без всякой нужды.
 * - Повторная блокировка уже своих строк мгновенна, поэтому звать можно
 *   несколько раз за транзакцию.
 */
export async function lockStockRows(tx: Tx, tenantId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM products
    WHERE tenant_id = ${tenantId} AND id IN (${Prisma.join(ids)})
    ORDER BY id COLLATE "C"
    FOR NO KEY UPDATE`;
}

export interface Reservation {
  productId: string;
  name: string;
  units: number;
}

// Decrement stock for tracked products with a re-check inside the transaction,
// so two terminals can't both sell the last unit. Throws if any product is short.
// Returns true when a sale had to take some balance below zero — possible only
// with allowNegative (an offline sale: the goods are already gone, refusing the
// record would only hide them from the books).
export async function reserveStock(
  tx: Tx,
  params: { tenantId: string; userId?: string; orderId: string; reservations: Reservation[]; allowNegative?: boolean }
): Promise<boolean> {
  const { tenantId, userId, orderId, reservations, allowNegative = false } = params;
  let shortfall = false;
  await lockStockRows(tx, tenantId, reservations.map((r) => r.productId));
  for (const r of reservations) {
    const fresh = await tx.product.findUnique({ where: { id: r.productId } });
    if (!fresh || !hasEnough(fresh.currentStock, r.units)) {
      if (!fresh || !allowNegative) {
        throw new Error(
          `Недостаточно товара «${fresh?.name || r.name}» на складе: осталось ${fresh ? roundStock(fresh.currentStock) : 0}${stockUnitLabel(fresh?.saleUnit)}`
        );
      }
      shortfall = true;
    }
    // Written as a value, not a decrement, so it can be rounded. The row is
    // locked (lockStockRows above) and the balance re-read after the lock,
    // which is what stops two terminals from both selling the last unit.
    await tx.product.update({
      where: { id: r.productId },
      data: { currentStock: roundStock(fresh.currentStock - r.units) },
    });
    await tx.inventoryMovement.create({
      data: {
        tenantId,
        productId: r.productId,
        type: "out",
        quantity: r.units,
        reason: `Резерв: заказ #${orderId.slice(0, 8)}`,
        referenceId: orderId,
        userId,
      },
    });
  }
  return shortfall;
}

// Reverse of reserveStock — used when an order is cancelled.
export async function releaseStock(
  tx: Tx,
  params: { tenantId: string; userId?: string; orderId: string; reservations: Reservation[] }
): Promise<void> {
  const { tenantId, userId, orderId, reservations } = params;
  await lockStockRows(tx, tenantId, reservations.map((r) => r.productId));
  for (const r of reservations) {
    const fresh = await tx.product.findUniqueOrThrow({ where: { id: r.productId } });
    await tx.product.update({
      where: { id: r.productId },
      data: { currentStock: roundStock(fresh.currentStock + r.units) },
    });
    await tx.inventoryMovement.create({
      data: {
        tenantId,
        productId: r.productId,
        type: "in",
        quantity: r.units,
        reason: `Отмена заказа #${orderId.slice(0, 8)} — снят резерв`,
        referenceId: orderId,
        userId,
      },
    });
  }
}

interface TechCardLine {
  ingredientId: string;
  quantity: number;
}

// A product's recipe lives either in the linked TechCard entity (what the admin
// UI writes via `techCardId`) or in the legacy per-product `techCard` JSON.
// Both are honoured; the linked card wins when present.
export function recipeFor(product: { techCard: string | null; techCardRef?: { ingredients: string } | null }): TechCardLine[] {
  const raw = product.techCardRef?.ingredients ?? product.techCard ?? "[]";
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((l) => l && typeof l.ingredientId === "string" && Number(l.quantity) > 0)
      : [];
  } catch {
    return [];
  }
}

// Write off recipe ingredients for every item of a paid order. Ingredient stock
// is allowed to go negative — a wrong count in the pantry must not block a sale,
// and a negative balance is visible in the low-stock report for correction.
export async function deductTechCardIngredients(
  tx: Tx,
  params: { tenantId: string; userId?: string; orderId: string }
): Promise<void> {
  const { tenantId, userId, orderId } = params;
  const items = await tx.orderItem.findMany({
    where: { orderId },
    include: { product: { include: { techCardRef: { select: { ingredients: true } } } } },
  });

  // Все ингредиенты заказа блокируются разом и в одном порядке — до первого
  // списания (см. lockStockRows).
  await lockStockRows(
    tx,
    tenantId,
    items.flatMap((item) => recipeFor(item.product).map((line) => line.ingredientId))
  );

  for (const item of items) {
    for (const line of recipeFor(item.product)) {
      const ingredient = await tx.product.findFirst({ where: { id: line.ingredientId, tenantId } });
      if (!ingredient) continue;

      // Округление — как у остатка, до тысячных: в килограммах это грамм.
      // round2 (до сотых) списывал 4 г специй как 0, а 15 г — как 20.
      const units = roundStock(Number(line.quantity) * item.quantity);
      await tx.product.update({
        where: { id: ingredient.id },
        data: { currentStock: roundStock(ingredient.currentStock - units) },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          productId: ingredient.id,
          type: "out",
          quantity: units,
          reason: `Списание по техкарте «${item.product.name}»: заказ #${orderId.slice(0, 8)}`,
          referenceId: orderId,
          userId,
        },
      });
    }
  }
}
