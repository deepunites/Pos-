import { randomId } from "./id";

/**
 * Ключ идемпотентности продажи (заголовок Idempotency-Key, см.
 * backend/src/utils/idempotency.ts).
 *
 * Связь оборвалась посреди оплаты — касса не знает, пробит ли чек. Ключ живёт,
 * пока продажа не прошла, поэтому повтор той же продажи уходит с тем же ключом,
 * и сервер возвращает уже пробитый чек, а не создаёт второй.
 *
 * «Та же продажа» — та же смена и те же строки. Способ оплаты и ожидаемая сумма
 * в отпечаток не входят: повтор картой после потерянной оплаты наличными — это
 * повтор, а не новая продажа (сервер ответит 422, если первая уже прошла).
 * Хранится в localStorage, чтобы пережить перезагрузку планшета.
 */

const STORAGE_KEY = "pos-checkout-key";
// Сервер помнит ключи неделю (столько ждут связи и офлайн-чеки). Здесь ключ
// живёт полсуток: та же корзина на следующий день — уже новая продажа.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface SavedKey {
  key: string;
  fingerprint: string;
  createdAt: number;
}

export interface SaleIdentity {
  cashShiftId: string;
  items: unknown[];
}

function read(): SavedKey | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedKey) : null;
  } catch {
    return null;
  }
}

export function checkoutKeyFor(sale: SaleIdentity, now = Date.now()): string {
  const fingerprint = JSON.stringify([sale.cashShiftId, sale.items]);
  const saved = read();
  if (saved && saved.fingerprint === fingerprint && now - saved.createdAt < MAX_AGE_MS) return saved.key;
  const next: SavedKey = { key: `sale-${randomId()}`, fingerprint, createdAt: now };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // без хранилища ключ всё равно защищает повтор в пределах этой страницы
  }
  return next.key;
}

// Продажа прошла — следующая продажа с тем же составом будет новой.
export function forgetCheckoutKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // нечего забывать
  }
}
