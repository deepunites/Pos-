import { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import { ci, searchTokens } from "../../utils/search.js";
import { AppError, ConflictError, NotFoundError } from "../../utils/errors.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";
import { round2, type Tx } from "../inventory/stock.helpers.js";
import { debtAgeDays, debtLabel, oldestUnpaidDebt, type DebtLabel } from "./customer.debt.js";
import type { CreateCustomerInput, CustomerQueryInput, RepaymentInput, UpdateCustomerInput } from "./customer.schema.js";

type CustomerRow = Prisma.CustomerGetPayload<object>;

export interface CustomerView extends CustomerRow {
  label: DebtLabel;
  /** Когда сделан самый старый непогашенный долг и сколько дней он висит. */
  debtSince: Date | null;
  debtDays: number;
}

const LABEL_TEXT: Record<DebtLabel, string> = { ok: "Надёжный", warn: "Внимание", blocked: "Не давать в долг" };

/**
 * Блокирует строку клиента до конца транзакции: две кассы, одновременно
 * пишущие долг одному клиенту, не затрут debtBalance друг друга.
 */
async function lockCustomer(tx: Tx, tenantId: string, id: string): Promise<CustomerRow | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM customers WHERE id = ${id} AND tenant_id = ${tenantId} FOR NO KEY UPDATE`;
  if (rows.length === 0) return null;
  return tx.customer.findUniqueOrThrow({ where: { id } });
}

async function debtSinceFor(db: Tx | typeof prisma, tenantId: string, ids: string[]): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>();
  if (ids.length === 0) return result;
  const entries = await db.customerDebtEntry.findMany({
    where: { tenantId, customerId: { in: ids } },
    select: { customerId: true, amount: true, createdAt: true },
  });
  for (const id of ids) result.set(id, oldestUnpaidDebt(entries.filter((e) => e.customerId === id)));
  return result;
}

async function withLabels(db: Tx | typeof prisma, tenantId: string, customers: CustomerRow[], now = new Date()): Promise<CustomerView[]> {
  const since = await debtSinceFor(
    db,
    tenantId,
    customers.filter((c) => c.debtBalance > 0.005).map((c) => c.id)
  );
  return customers.map((c) => {
    const at = since.get(c.id) ?? null;
    return { ...c, label: debtLabel(c, at, now), debtSince: at, debtDays: debtAgeDays(at, now) };
  });
}

function duplicatePhone(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export const customerService = {
  async list(tenantId: string, query: CustomerQueryInput): Promise<CustomerView[]> {
    const and: Prisma.CustomerWhereInput[] = [];
    if (query.search) {
      const digits = query.search.replace(/\D/g, "");
      // Набрали цифры — ищем по телефону (обычно последние цифры), иначе по имени.
      if (digits.length >= 3 && !/\p{L}/u.test(query.search)) {
        and.push({ OR: [{ phone: { contains: digits } }, { phone2: { contains: digits } }] });
      } else {
        for (const word of searchTokens(query.search)) and.push({ OR: [{ firstName: ci(word) }, { lastName: ci(word) }] });
      }
    }
    if (query.withDebt) and.push({ debtBalance: { gt: 0.005 } });
    const customers = await prisma.customer.findMany({
      where: { tenantId, AND: and },
      orderBy: [{ debtBalance: "desc" }, { firstName: "asc" }],
      take: query.limit ?? 50,
    });
    return withLabels(prisma, tenantId, customers);
  },

  async summary(tenantId: string) {
    const debtors = await prisma.customer.findMany({ where: { tenantId, debtBalance: { gt: 0.005 } } });
    const labelled = await withLabels(prisma, tenantId, debtors);
    const [total] = await Promise.all([prisma.customer.count({ where: { tenantId } })]);
    return {
      customers: total,
      debtors: debtors.length,
      totalDebt: round2(debtors.reduce((sum, c) => sum + c.debtBalance, 0)),
      overdueDebt: round2(labelled.filter((c) => c.debtDays >= 30).reduce((sum, c) => sum + c.debtBalance, 0)),
    };
  },

  async findById(tenantId: string, id: string) {
    const customer = await prisma.customer.findFirst({ where: { id, tenantId } });
    if (!customer) throw new NotFoundError("Клиент не найден");
    const [view] = await withLabels(prisma, tenantId, [customer]);
    const history = await prisma.customerDebtEntry.findMany({
      where: { tenantId, customerId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { order: { select: { id: true, orderNumber: true, total: true } } },
    });
    return { ...view, history };
  },

  async create(tenantId: string, data: CreateCustomerInput) {
    try {
      const customer = await prisma.customer.create({ data: { tenantId, ...data } });
      const [view] = await withLabels(prisma, tenantId, [customer]);
      return view;
    } catch (error) {
      if (duplicatePhone(error)) throw new ConflictError("Клиент с таким телефоном уже есть — найдите его по номеру");
      throw error;
    }
  },

  async update(tenantId: string, id: string, data: UpdateCustomerInput) {
    const existing = await prisma.customer.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) throw new NotFoundError("Клиент не найден");
    try {
      const customer = await prisma.customer.update({ where: { id }, data });
      const [view] = await withLabels(prisma, tenantId, [customer]);
      return view;
    } catch (error) {
      if (duplicatePhone(error)) throw new ConflictError("Клиент с таким телефоном уже есть");
      throw error;
    }
  },

  /** Клиент приносит деньги в счёт долга — на кассе (в её смену) или в админке. */
  async repay(tenantId: string, userId: string, id: string, input: RepaymentInput, idem?: IdempotencyContext | null) {
    const entryId = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const customer = await lockCustomer(tx, tenantId, id);
      if (!customer) throw new NotFoundError("Клиент не найден");
      const amount = round2(input.amount);
      if (amount > customer.debtBalance + 0.01) {
        throw new AppError(`Это больше долга клиента (${round2(customer.debtBalance)})`);
      }
      if (input.cashShiftId) {
        const shift = await tx.cashShift.findFirst({ where: { id: input.cashShiftId, tenantId, status: "open" }, select: { id: true } });
        if (!shift) throw new AppError("Смена не найдена или уже закрыта");
      }
      const entry = await tx.customerDebtEntry.create({
        data: {
          tenantId,
          customerId: id,
          type: "repayment",
          amount: -amount,
          method: input.method,
          cashShiftId: input.cashShiftId,
          userId,
          note: input.note,
        },
      });
      await tx.customer.update({ where: { id }, data: { debtBalance: round2(customer.debtBalance - amount) } });
      await attachIdempotencyResource(tx, tenantId, idem, entry.id);
      return entry.id;
    });
    return this.repaymentResult(tenantId, entryId);
  },

  /** Ответ на погашение (и на его повтор с тем же ключом): запись и клиент после неё. */
  async repaymentResult(tenantId: string, entryId: string) {
    const entry = await prisma.customerDebtEntry.findFirst({ where: { id: entryId, tenantId } });
    if (!entry) throw new NotFoundError("Погашение не найдено");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: entry.customerId } });
    const [view] = await withLabels(prisma, tenantId, [customer]);
    return { entry, customer: view };
  },
};

/**
 * Продажа в долг внутри транзакции чека: проверить, что клиенту можно, и
 * записать долг. Вызывается из orderService.checkout.
 */
export async function chargeDebt(
  tx: Tx,
  args: { tenantId: string; customerId: string; orderId: string; amount: number; cashShiftId?: string | null; userId: string; at?: Date }
): Promise<CustomerRow> {
  const customer = await lockCustomer(tx, args.tenantId, args.customerId);
  if (!customer) throw new NotFoundError("Клиент не найден");
  const since = (await debtSinceFor(tx, args.tenantId, [customer.id])).get(customer.id) ?? null;
  const label = debtLabel(customer, since);
  if (label === "blocked") {
    throw new ConflictError(
      customer.debtBlocked
        ? `${customer.firstName}: в долг не продаём — так отмечено в карточке клиента`
        : `${customer.firstName}: в долг не продаём — долг висит ${debtAgeDays(since)} дней`
    );
  }
  const amount = round2(args.amount);
  await tx.customerDebtEntry.create({
    data: {
      tenantId: args.tenantId,
      customerId: customer.id,
      type: "sale",
      amount,
      orderId: args.orderId,
      cashShiftId: args.cashShiftId ?? undefined,
      userId: args.userId,
      ...(args.at ? { createdAt: args.at } : {}),
    },
  });
  return tx.customer.update({ where: { id: customer.id }, data: { debtBalance: round2(customer.debtBalance + amount) } });
}

/** Возврат долговой части чека: долг клиента уменьшается на неё. */
export async function refundDebt(
  tx: Tx,
  args: { tenantId: string; customerId: string; orderId: string; amount: number; userId?: string; note?: string }
): Promise<void> {
  const customer = await lockCustomer(tx, args.tenantId, args.customerId);
  if (!customer) return;
  const amount = round2(args.amount);
  await tx.customerDebtEntry.create({
    data: { tenantId: args.tenantId, customerId: customer.id, type: "refund", amount: -amount, orderId: args.orderId, userId: args.userId, note: args.note },
  });
  await tx.customer.update({ where: { id: customer.id }, data: { debtBalance: round2(customer.debtBalance - amount) } });
}

export { LABEL_TEXT };
