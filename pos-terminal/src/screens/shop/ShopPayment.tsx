import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Banknote, Check, CreditCard, Delete, QrCode, WalletCards } from "lucide-react";
import toast from "react-hot-toast";
import api from "../../services/api";
import { useCartStore } from "../../store/cartStore";
import type { Order, Product } from "../../types";
import { useMoney } from "../../hooks/useMoney";
import { round2 } from "../../utils/money";
import { parseDecimal } from "../../utils/weight";
import { isNoConnection, paymentErrorMessage } from "../../utils/apiError";
import { checkoutKeyFor, forgetCheckoutKey } from "../../utils/checkoutKey";
import { offlineTooLong, useConnection } from "../../services/connection";
import { enqueueSale, stockUnits, type QueuedSale } from "../../services/offlineQueue";
import { takeFromCatalog } from "../../services/offlineCatalog";
import { sessionClaims } from "../../services/session";

/** Как платит покупатель. `mixed` — часть картой, остаток наличными. */
export type PayMode = "cash" | "card" | "mixed" | "qr";

export interface SaleResult {
  order: Order;
  /** Пробит без связи: чек на планшете, уйдёт на сервер позже (номера ещё нет). */
  offline?: QueuedSale;
  method: PayMode;
  total: number;
  /** What the customer handed over (cash only); null when paid exactly. */
  tendered: number | null;
  change: number;
  /** «Карта + наличные»: сколько прошло картой (остальное — наличными). */
  cardAmount?: number;
}

interface ShopPaymentProps {
  mode: PayMode;
  total: number;
  shiftId: string;
  /** Назад к выбору способа — чек остаётся как был. */
  onClose: () => void;
  onPaid: (result: SaleResult) => void;
}

const PAY_MODES: Record<PayMode, { label: string; icon: typeof Banknote }> = {
  cash: { label: "Наличные", icon: Banknote },
  card: { label: "Карта", icon: CreditCard },
  mixed: { label: "Карта + наличные", icon: WalletCards },
  qr: { label: "QR", icon: QrCode },
};

/** Продажа без связи невозможна (не наличные, слишком давно без связи) — сказать кассиру почему. */
class OfflineRefused extends Error {}

const CASH_CHECKOUT_TIMEOUT_MS = 8000;

/**
 * Banknotes the customer is likely to hand over: the next round sum above the
 * total for each denomination, smallest first. 185 576 → 186 000, 190 000, 200 000.
 */
export function cashSuggestions(total: number, fractionDigits: number): number[] {
  const denominations = fractionDigits === 0 ? [1_000, 5_000, 10_000, 50_000, 100_000, 200_000] : [1, 5, 10, 20, 50, 100];
  const sums = denominations.map((d) => Math.ceil(total / d) * d).filter((sum) => sum > total);
  return Array.from(new Set(sums)).sort((a, b) => a - b).slice(0, 3);
}

/**
 * Оплата чека — в правой панели кассы, а не во всплывающем окне: чек слева
 * виден, клавиатура и зелёная кнопка там же, где были. Наличные — «клиент дал»
 * и сдача; карта — подтверждение «Оплачено»; «Карта + наличные» — сумма картой,
 * наличные считаются сами.
 */
export default function ShopPayment({ mode, total, shiftId, onClose, onPaid }: ShopPaymentProps) {
  const { money, parts, fractionDigits } = useMoney();
  const qc = useQueryClient();
  const { customerName, customerPhone } = useCartStore();
  const [text, setText] = useState("");

  const cash = mode === "cash";
  const mixed = mode === "mixed";
  const typing = cash || mixed;

  const entered = text ? parseDecimal(text) : null;
  // Наличные: что дал покупатель (пусто — без сдачи).
  const tendered = cash ? entered : null;
  const change = cash ? Math.max(0, round2((tendered ?? total) - total)) : 0;
  const short = cash && tendered !== null && tendered < total - 0.005;
  // «Карта + наличные»: картой — сколько набрали, наличными — остаток.
  const cardPart = mixed ? round2(entered ?? 0) : 0;
  const cashPart = mixed ? round2(total - cardPart) : 0;
  const splitOk = !mixed || (cardPart > 0 && cashPart > 0);

  const offlineNow = useConnection((s) => s.problem !== null);

  const checkout = useMutation({
    mutationFn: async (): Promise<{ order: Order | null; offline?: QueuedSale }> => {
      const { items } = useCartStore.getState();
      const lines = items.map((item) => ({ productId: item.productId, quantity: item.quantity, grams: item.grams }));
      // Повтор после обрыва связи — с тем же ключом: второй чек не создастся.
      const key = checkoutKeyFor({ cashShiftId: shiftId, items: lines });
      const body = {
        type: "takeaway",
        cashShiftId: shiftId,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        items: lines,
        expectedTotal: total,
        ...(mixed
          ? { payments: [{ method: "card", amount: cardPart }, { method: "cash", amount: cashPart }] }
          : { payment: { method: mode } }),
      };

      // Офлайн-режим: без связи — только наличные, и чек ложится на планшет.
      // `online` — запрос, который ушёл и остался без ответа: очередь сначала
      // повторит его же (вдруг сервер его записал), а не пробьёт второй чек.
      const saveOffline = async (online?: { key: string; body: unknown }) => {
        const claims = sessionClaims();
        if (!claims?.tenantId) throw new OfflineRefused("Нет связи, а касса не знает свою точку — войдите заново, когда связь вернётся");
        const sale = await enqueueSale({
          tenantId: claims.tenantId,
          shiftId,
          cashierId: claims.id,
          items,
          total,
          tendered,
          customerName,
          customerPhone,
          online,
        });
        await takeFromCatalog(stockUnits(items));
        return { order: null, offline: sale };
      };

      if (useConnection.getState().problem) {
        if (!cash) throw new OfflineRefused("Без связи принимаются только наличные");
        if (offlineTooLong()) throw new OfflineRefused("Касса без связи больше двух суток — подключите интернет, чтобы продавать дальше");
        return saveOffline();
      }
      try {
        // Наличные не ждут 30 секунд «висящего» интернета: через 8 секунд чек
        // ложится на планшет (с этим же ключом — дошёл он до сервера или нет,
        // повтор не создаст второй). Карту ждём дольше: ей без связи некуда.
        const res = await api.post("/orders/checkout", body, {
          headers: { "Idempotency-Key": key },
          ...(cash ? { timeout: CASH_CHECKOUT_TIMEOUT_MS } : {}),
        });
        return { order: res.data.data as Order };
      } catch (error) {
        if (cash && isNoConnection(error) && !offlineTooLong()) return saveOffline({ key, body });
        throw error;
      }
    },
    onSuccess: ({ order, offline }) => {
      forgetCheckoutKey();
      // Stock moved on the server — tiles, quick keys and suggestions must not show yesterday's numbers.
      for (const key of ["shop-tiles", "shop-quick", "shop-suggest", "cash-shift"]) qc.invalidateQueries({ queryKey: [key] });
      useCartStore.getState().clearCart();
      const shown = order ?? ({ id: offline!.id, orderNumber: "", total } as unknown as Order);
      onPaid({ order: shown, offline, method: mode, total, tendered, change, ...(mixed ? { cardAmount: cardPart } : {}) });
    },
    onError: async (error: Error & { response?: { status?: number; data?: { error?: string } } }) => {
      if (error instanceof OfflineRefused) {
        toast.error(error.message, { duration: 6000 });
        return;
      }
      if (error.response?.status === 409) {
        // Prices changed under the cart: re-price it from fresh product records and let the cashier look again.
        try {
          const ids = Array.from(new Set(useCartStore.getState().items.map((i) => i.productId)));
          const fresh = await Promise.all(ids.map((id) => api.get(`/products/${id}`).then((r) => r.data.data as Product)));
          useCartStore.getState().repriceItems(fresh);
        } catch {
          // the message below still tells the cashier to re-check the sum
        }
        toast.error(error.response.data?.error || "Цены изменились — проверьте чек", { duration: 5000 });
        onClose();
        return;
      }
      toast.error(paymentErrorMessage(error), { duration: 8000 });
    },
  });

  const canConfirm = !checkout.isPending && !short && splitOk;
  const confirm = useCallback(() => {
    if (canConfirm) checkout.mutate();
  }, [canConfirm, checkout]);

  const press = useCallback(
    (key: string) => {
      setText((current) => {
        if (key === ",") {
          if (fractionDigits === 0 || current.includes(",")) return current;
          return current === "" ? "0," : current + ",";
        }
        const [, frac] = current.split(",");
        if (frac !== undefined && frac.length >= fractionDigits) return current;
        if (current.replace(",", "").length + key.length > 10) return current;
        if (current === "" && /^0+$/.test(key)) return current;
        return current + key;
      });
    },
    [fractionDigits]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing && /^\d$/.test(e.key)) press(e.key);
      else if (typing && (e.key === "," || e.key === ".")) press(",");
      else if (typing && e.key === "Backspace") setText((c) => c.slice(0, -1));
      else if (e.key === "Enter") confirm();
      else if (e.key === "Escape" && !checkout.isPending) onClose();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [typing, press, confirm, onClose, checkout.isPending]);

  const suggestions = useMemo(() => (cash ? cashSuggestions(total, fractionDigits) : []), [cash, total, fractionDigits]);
  const { label, icon: Icon } = PAY_MODES[mode];
  const totalParts = parts(total);
  const amount = (value: number, placeholder = false) => {
    const p = parts(value);
    return (
      <div className={`v tab${placeholder ? " ph" : ""}`}>
        {!p.suffix && <small style={{ marginLeft: 0, marginRight: 6 }}>{p.symbol}</small>}
        {p.figure}
        {p.suffix && <small>{p.symbol}</small>}
      </div>
    );
  };

  const keypad = (
    <div className="sh-kp">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
        <button key={k} onClick={() => press(k)}>
          {k}
        </button>
      ))}
      <button onClick={() => press(fractionDigits === 0 ? "00" : ",")}>{fractionDigits === 0 ? "00" : ","}</button>
      <button onClick={() => press("0")}>0</button>
      <button onClick={() => setText((c) => c.slice(0, -1))} aria-label="Стереть">
        <Delete className="i" />
      </button>
    </div>
  );

  const okLabel = cash
    ? short
      ? `Не хватает ${money(total - (tendered ?? 0))}`
      : "Оплатить"
    : mixed
      ? splitOk
        ? `Оплатить · ${money(cardPart)} + ${money(cashPart)}`
        : "Введите сумму картой"
      : `Оплачено · ${money(total)}`;

  return (
    <aside className="sh-side sh-pp" aria-label={`Оплата: ${label}`}>
      <div className="sh-pp-head">
        <button className="sh-pp-back" onClick={onClose} disabled={checkout.isPending}>
          <ArrowLeft className="i" />
          Способ оплаты
        </button>
        <span className="m">
          <Icon className="i" />
          {label}
        </span>
      </div>

      <div className="sh-pp-total">
        <span className="lbl">К оплате</span>
        <span className="v tab">
          {!totalParts.suffix && <small style={{ marginLeft: 0, marginRight: 6 }}>{totalParts.symbol}</small>}
          {totalParts.figure}
          {totalParts.suffix && <small>{totalParts.symbol}</small>}
        </span>
      </div>

      {cash && (
        <>
          {offlineNow && <div className="sh-pp-note">Нет связи — чек сохранится на кассе и уйдёт на сервер сам</div>}
          <div className="sh-pp-box act">
            <div className="lbl">Клиент дал</div>
            {amount(tendered ?? total, tendered === null)}
          </div>
          <div className={`sh-pp-box ${short ? "short" : "chg"}`}>
            <div className="lbl">{short ? "Не хватает" : "Сдача"}</div>
            {amount(short ? total - (tendered ?? 0) : change)}
          </div>
          {keypad}
          <div className="sh-pp-quick">
            <button className={text === "" ? "on" : ""} onClick={() => setText("")}>
              Без сдачи
            </button>
            {suggestions.map((sum) => (
              <button key={sum} className={`tab${tendered === sum ? " on" : ""}`} onClick={() => setText(String(sum).replace(".", ","))}>
                {parts(sum).figure}
              </button>
            ))}
          </div>
        </>
      )}

      {mode === "card" && (
        <div className="sh-pp-card">
          <CreditCard className="i" />
          <div>
            Проведите <b>{money(total)}</b> на банковском терминале
            <br />
            или примите <b>перевод на карту</b>.
          </div>
          <small>Когда деньги пришли — нажмите «Оплачено».</small>
        </div>
      )}

      {mode === "qr" && (
        <div className="sh-pp-card">
          <QrCode className="i" />
          <div>
            Клиент оплачивает по <b>QR-коду</b> в приложении банка.
          </div>
          <small>Когда деньги пришли — нажмите «Оплачено».</small>
        </div>
      )}

      {mixed && (
        <>
          <div className="sh-pp-box act">
            <div className="lbl">
              <CreditCard className="i" />
              Картой
            </div>
            {amount(cardPart, text === "")}
          </div>
          <div className="sh-pp-box">
            <div className="lbl">
              <Banknote className="i" />
              Наличными — остаток, считается сам
            </div>
            {amount(Math.max(0, cashPart))}
          </div>
          {keypad}
        </>
      )}

      <div className="sh-pay">
        <button className="sh-pp-ok" onClick={confirm} disabled={!canConfirm}>
          {checkout.isPending ? (
            <>
              <span className="sh-spin" /> Проводим…
            </>
          ) : (
            <>
              {canConfirm && <Check className="i" />}
              {okLabel}
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
