import api from "../../services/api";
import { formatLocal, localDigits, UZ_PREFIX } from "../../utils/phone";

// Клиенты заведения на кассе: поиск, метки и подписи — общие для оплаты
// «В долг» и окна «Долги».

export type DebtLabel = "ok" | "warn" | "blocked";

export interface Customer {
  id: string;
  firstName: string;
  lastName?: string | null;
  phone: string;
  phone2?: string | null;
  rating?: number | null;
  note?: string | null;
  debtBlocked: boolean;
  debtBalance: number;
  /** Ставится сервером по самому старому непогашенному долгу (30 / 60 дней). */
  label: DebtLabel;
  debtDays: number;
}

export const LABEL_TEXT: Record<DebtLabel, string> = { ok: "Надёжный", warn: "Внимание", blocked: "Не давать в долг" };

export const fullName = (c: Pick<Customer, "firstName" | "lastName">): string => [c.firstName, c.lastName].filter(Boolean).join(" ");

export const initials = (c: Pick<Customer, "firstName" | "lastName">): string => `${c.firstName[0] ?? ""}${c.lastName?.[0] ?? ""}`.toUpperCase();

/** 4 → «★★★★☆»; без оценки — пусто. */
export const stars = (rating?: number | null): string => (rating ? "★".repeat(rating) + "☆".repeat(5 - rating) : "");

/** «+998901234567» → «+998 90 123-45-67». */
export const showPhone = (phone: string): string => `${UZ_PREFIX} ${formatLocal(localDigits(phone))}`;

export async function searchCustomers(search: string, withDebt = false): Promise<Customer[]> {
  const res = await api.get("/customers", { params: { search: search || undefined, withDebt: withDebt || undefined, limit: 8 } });
  return res.data.data as Customer[];
}
