import prisma from "../../config/database.js";
import { ForbiddenError } from "../../utils/errors.js";

// Права кассира — галочки в карточке сотрудника. Администратору и менеджеру
// разрешено всё, галочки касаются остальных ролей. Читаются из базы при каждом
// действии, а не из токена: снятая галочка действует сразу, без перевхода.

export const PERMISSIONS = ["canSellOnDebt", "canReceiveStock", "canSeeExpectedCash", "canRefund"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Permissions = Record<Permission, boolean>;

const ALL: Permissions = { canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true, canRefund: true };
const NONE: Permissions = { canSellOnDebt: false, canReceiveStock: false, canSeeExpectedCash: false, canRefund: false };
const SELECT = { canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true, canRefund: true } as const;

const DENIED: Record<Permission, string> = {
  canSellOnDebt: "Продажа в долг вам закрыта — обратитесь к администратору",
  canReceiveStock: "Оформлять приход вам закрыто — обратитесь к администратору",
  canSeeExpectedCash: "Сумма смены вам закрыта",
  canRefund: "Возврат товара вам закрыт — обратитесь к администратору",
};

export const fullAccess = (role: string) => role === "admin" || role === "manager";

/** Права из уже прочитанной строки сотрудника (вход по PIN, по паролю). */
export function permissionsFromRow(row: { role: string } & Permissions): Permissions {
  if (fullAccess(row.role)) return ALL;
  return { canSellOnDebt: row.canSellOnDebt, canReceiveStock: row.canReceiveStock, canSeeExpectedCash: row.canSeeExpectedCash, canRefund: row.canRefund };
}

export async function permissionsOf(user: { id: string; role: string }): Promise<Permissions> {
  if (fullAccess(user.role)) return ALL;
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: SELECT,
  });
  // Сотрудника нет (удалён) — ничего не разрешаем.
  return row ?? NONE;
}

export async function requirePermission(user: { id: string; role: string }, permission: Permission): Promise<void> {
  if (!(await permissionsOf(user))[permission]) throw new ForbiddenError(DENIED[permission]);
}

/** Поля смены, по которым видно, сколько наличных должно быть в кассе. */
const SHIFT_MONEY = [
  "totalSales",
  "totalCashSales",
  "totalCardSales",
  "totalQrSales",
  "totalDebtSales",
  "totalDebtRepaidCash",
  "totalDebtRepaidCard",
  "totalReturnsCash",
  "totalReturnsCard",
  "totalReturnsDebt",
  "totalTips",
  "totalRefunds",
  "expectedCash",
  "difference",
] as const;

/** «Слепая» смена: без итогов и ожидаемой суммы — кассир считает наличные сам. */
export function blindShift<T extends object | null>(shift: T): T {
  if (!shift) return shift;
  const copy: Record<string, unknown> = { ...shift, blind: true };
  for (const key of SHIFT_MONEY) delete copy[key];
  return copy as T;
}
