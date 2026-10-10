import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type { Tx } from "../inventory/stock.helpers.js";

/** Кто может провести деньги через чужую открытую смену. */
const SUPERVISORS = ["admin", "manager"];

/**
 * Открытая смена, через которую проходят деньги (возврат, погашение долга).
 * Кассир — только через свою: иначе возврат наличными или погашение,
 * записанные в смену другого кассира, дают тому ложную недостачу или излишек.
 */
export async function openShiftForMoney(tx: Tx, args: { tenantId: string; shiftId: string; userId: string; role: string }) {
  const shift = await tx.cashShift.findFirst({ where: { id: args.shiftId, tenantId: args.tenantId, status: "open" } });
  if (!shift) throw new NotFoundError("Открытая смена не найдена");
  if (shift.userId !== args.userId && !SUPERVISORS.includes(args.role)) {
    throw new ForbiddenError("Это смена другого кассира — проведите через свою смену");
  }
  return shift;
}

export const isSupervisor = (role: string): boolean => SUPERVISORS.includes(role);
