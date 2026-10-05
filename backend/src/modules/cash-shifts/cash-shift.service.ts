import type { ShiftQueryInput } from "./cash-shift.schema.js";
import { returnService } from "../returns/return.service.js";
import { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";

export class CashShiftService {
  async openShift(tenantId: string, userId: string, openingCash: number, notes?: string) {
    const activeShift = await prisma.cashShift.findFirst({
      where: { tenantId, userId, status: "open" },
    });
    if (activeShift) throw new ConflictError("У вас уже есть открытая смена");

    try {
      return await prisma.cashShift.create({
        data: {
          tenantId,
          userId,
          openingCash,
          notes,
          status: "open",
        },
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    } catch (error) {
      // Два одновременных открытия оба проходят проверку выше; второе
      // отбивает уникальный индекс cash_shifts_one_open_per_user — и кассир
      // должен увидеть то же понятное сообщение, а не «запись уже существует».
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("У вас уже есть открытая смена");
      }
      throw error;
    }
  }

  // Totals for a shift are computed live from its own orders' payments —
  // scoped by cashShiftId, not by a time window — so two cashiers with
  // overlapping open shifts never see each other's sales. Used both to show
  // a real (non-zero) preview before closing and to persist the final
  // numbers at close time.
  private async computeShiftTotals(tenantId: string, shiftId: string, openingCash: number) {
    const payments = await prisma.payment.findMany({
      where: { tenantId, status: "completed", order: { cashShiftId: shiftId } },
    });

    let totalCashSales = 0;
    let totalCardSales = 0;
    let totalQrSales = 0;
    let totalDebtSales = 0;
    let totalTips = 0;

    for (const payment of payments) {
      if (payment.method === "cash") totalCashSales += payment.amount;
      else if (payment.method === "card") totalCardSales += payment.amount;
      else if (payment.method === "qr") totalQrSales += payment.amount;
      else if (payment.method === "debt") totalDebtSales += payment.amount;
      totalTips += payment.tipAmount;
    }

    // Погашения долгов на этой кассе: наличные лежат в ящике, карта — нет.
    const repayments = await prisma.customerDebtEntry.findMany({
      where: { tenantId, cashShiftId: shiftId, type: "repayment" },
      select: { amount: true, method: true },
    });
    const totalDebtRepaidCash = repayments.filter((r) => r.method === "cash").reduce((sum, r) => sum - r.amount, 0);
    const totalDebtRepaidCard = repayments.filter((r) => r.method === "card").reduce((sum, r) => sum - r.amount, 0);

    const refunds = await prisma.payment.findMany({
      where: { tenantId, status: "refunded", order: { cashShiftId: shiftId } },
    });
    const totalRefunds = refunds.reduce((sum, p) => sum + p.amount, 0);

    // Возвраты товара на этой кассе (и по чекам прошлых смен): наличные кассир
    // отдал из ящика — их там больше нет.
    const returns = await returnService.shiftTotals(tenantId, shiftId);

    // Продажа в долг — тоже продажа смены, но денег в ящик она не приносит.
    const totalSales = totalCashSales + totalCardSales + totalQrSales + totalDebtSales;
    // Возврат не создаёт новой записи, а переводит платёж в «refunded», и тот
    // выпадает из продаж выше. Поэтому в ящике — начальная сумма плюс
    // невозвращённые продажи наличными, и только. Раньше отсюда ещё раз
    // вычиталась сумма всех возвратов: возврат наличных учитывался дважды
    // (ложный излишек при закрытии), а возврат по карте или QR забирал из
    // ящика деньги, которых там никогда не было (ложная недостача).
    const expectedCash = openingCash + totalCashSales + totalDebtRepaidCash - returns.totalReturnsCash;

    return {
      totalSales,
      totalCashSales,
      totalCardSales,
      totalQrSales,
      totalDebtSales,
      totalDebtRepaidCash,
      totalDebtRepaidCard,
      totalTips,
      totalRefunds,
      ...returns,
      expectedCash,
    };
  }

  // A manager or admin can close a shift left open by a cashier who already
  // went home; anyone else may only close their own.
  async closeShift(tenantId: string, shiftId: string, userId: string, role: string, closingCash: number, notes?: string) {
    const shift = await prisma.cashShift.findFirst({
      where: { id: shiftId, tenantId, status: "open" },
    });
    if (!shift) throw new NotFoundError("Смена не найдена или уже закрыта");
    const isSupervisor = role === "admin" || role === "manager";
    if (shift.userId !== userId && !isSupervisor) {
      throw new ForbiddenError("Нет прав закрыть чужую смену");
    }
    const supervisorNote =
      shift.userId !== userId ? `Смена закрыта администратором (${role})` : undefined;

    const totals = await this.computeShiftTotals(tenantId, shiftId, shift.openingCash);
    const difference = closingCash - totals.expectedCash;

    const updatedShift = await prisma.cashShift.update({
      where: { id: shiftId },
      data: {
        status: "closed",
        closingCash,
        ...totals,
        difference,
        notes: [shift.notes, supervisorNote, notes].filter(Boolean).join("\n").trim() || null,
        closedAt: new Date(),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return updatedShift;
  }

  async getCurrentShift(tenantId: string, userId: string) {
    const shift = await prisma.cashShift.findFirst({
      where: { tenantId, userId, status: "open" },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        orders: {
          select: { id: true, orderNumber: true, total: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!shift) return shift;
    const totals = await this.computeShiftTotals(tenantId, shift.id, shift.openingCash);
    return { ...shift, ...totals };
  }

  async findAll(tenantId: string, query: ShiftQueryInput) {
    const { page = 1, limit = 20, status, userId } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.CashShiftWhereInput = { tenantId };
    if (status) where.status = status;
    if (userId) where.userId = userId;

    const [rows, total] = await Promise.all([
      prisma.cashShift.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { orders: true } },
        },
        orderBy: { openedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.cashShift.count({ where }),
    ]);

    // An open shift has not written its totals yet (that happens at close),
    // so they are computed live — otherwise the list showed every running
    // shift as zero sales.
    const shifts = await Promise.all(
      rows.map(async (shift) =>
        shift.status === "open"
          ? { ...shift, ...(await this.computeShiftTotals(tenantId, shift.id, shift.openingCash)) }
          : shift
      )
    );

    return { shifts, total, page, limit };
  }

  async findById(tenantId: string, id: string) {
    const shift = await prisma.cashShift.findFirst({
      where: { id, tenantId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        orders: {
          include: {
            items: { select: { quantity: true, totalPrice: true } },
            payments: { select: { method: true, amount: true, status: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!shift) throw new NotFoundError("Смена не найдена");

    // While a shift is still open its totalSales/totalCashSales/etc columns
    // are just the defaults (0) — they're only written at close time. Fill
    // them in live so the pre-close summary isn't blank.
    if (shift.status === "open") {
      const totals = await this.computeShiftTotals(tenantId, shift.id, shift.openingCash);
      return { ...shift, ...totals };
    }

    return shift;
  }
}

export const cashShiftService = new CashShiftService();
