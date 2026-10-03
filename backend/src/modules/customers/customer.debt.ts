// Метка клиента по его долгу — считается, а не хранится: зависит от того,
// сколько дней висит самый старый непогашенный долг. Погашения и возвраты
// закрывают сначала самые старые продажи в долг (FIFO).

export const DEBT_WARN_DAYS = 30;
export const DEBT_BLOCK_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPS = 0.005;

export type DebtLabel = "ok" | "warn" | "blocked";

export interface DebtEntryLike {
  amount: number; // + долг вырос, − уменьшился
  createdAt: Date;
}

/** Когда сделан самый старый ещё не погашенный долг; null — долга нет. */
export function oldestUnpaidDebt(entries: DebtEntryLike[]): Date | null {
  const sorted = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const open: { at: Date; left: number }[] = [];
  let credit = 0; // погашено сверх продаж к этому моменту
  for (const entry of sorted) {
    if (entry.amount > 0) {
      let left = entry.amount;
      const used = Math.min(credit, left);
      credit -= used;
      left -= used;
      if (left > EPS) open.push({ at: entry.createdAt, left });
    } else {
      let pay = -entry.amount;
      while (pay > EPS && open.length > 0) {
        const head = open[0];
        const used = Math.min(pay, head.left);
        head.left -= used;
        pay -= used;
        if (head.left <= EPS) open.shift();
      }
      credit += pay;
    }
  }
  return open.length > 0 ? open[0].at : null;
}

export function debtAgeDays(since: Date | null, now = new Date()): number {
  return since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : 0;
}

export function debtLabel(customer: { debtBlocked: boolean; debtBalance: number }, since: Date | null, now = new Date()): DebtLabel {
  if (customer.debtBlocked) return "blocked";
  if (customer.debtBalance <= EPS || !since) return "ok";
  const days = debtAgeDays(since, now);
  if (days >= DEBT_BLOCK_DAYS) return "blocked";
  if (days >= DEBT_WARN_DAYS) return "warn";
  return "ok";
}
