import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, Check, CreditCard, Delete, QrCode, X } from "lucide-react";
import toast from "react-hot-toast";
import api from "../../services/api";
import { useCartStore } from "../../store/cartStore";
import type { Order, PaymentMethod, Product } from "../../types";
import { useMoney } from "../../hooks/useMoney";
import { round2 } from "../../utils/money";
import { parseDecimal } from "../../utils/weight";
import { isNoConnection, paymentErrorMessage } from "../../utils/apiError";
import { checkoutKeyFor, forgetCheckoutKey } from "../../utils/checkoutKey";
import { offlineTooLong, useConnection } from "../../services/connection";
import { enqueueSale, stockUnits, type QueuedSale } from "../../services/offlineQueue";
import { takeFromCatalog } from "../../services/offlineCatalog";
import { sessionClaims } from "../../services/session";

export interface SaleResult {
  order: Order;
  /** Пробит без связи: чек на планшете, уйдёт на сервер позже (номера ещё нет). */
  offline?: QueuedSale;
  method: PaymentMethod;
  total: number;
  /** What the customer handed over (cash only); null when paid exactly. */
  tendered: number | null;
  change: number;
}

interface ShopPaymentProps {
  method: PaymentMethod;
  total: number;
  shiftId: string;
  onClose: () => void;
  onPaid: (result: SaleResult) => void;
}

const METHODS: Record<PaymentMethod, { label: string; icon: typeof Banknote }> = {
  cash: { label: "Наличные", icon: Banknote },
  card: { label: "Карта", icon: CreditCard },
  qr: { label: "QR", icon: QrCode },
};

/**
 * Banknotes the customer is likely to hand over: the next round sum above the
 * total for each denomination, smallest first. 185 576 → 186 000, 190 000, 200 000.
 */
/** Продажа без связи невозможна (не наличные, слишком давно без связи) — сказать кассиру почему. */
class OfflineRefused extends Error {}

const CASH_CHECKOUT_TIMEOUT_MS = 8000;

export function cashSuggestions(total: number, fractionDigits: number): number[] {
  const denominations = fractionDigits === 0 ? [1_000, 5_000, 10_000, 50_000, 100_000, 200_000] : [1, 5, 10, 20, 50, 100];
  const sums = denominations.map((d) => Math.ceil(total / d) * d).filter((sum) => sum > total);
  return Array.from(new Set(sums)).sort((a, b) => a - b).slice(0, 3);
}

export default function ShopPayment({ method, total, shiftId, onClose, onPaid }: ShopPaymentProps) {
  const { money, parts, fractionDigits } = useMoney();
  const qc = useQueryClient();
  const { customerName, customerPhone } = useCartStore();
  const [text, setText] = useState("");

  const cash = method === "cash";
  const tendered = text ? parseDecimal(text) : null;
  const paid = cash ? tendered ?? total : total;
  const change = Math.max(0, round2(paid - total));
  const short = cash && tendered !== null && tendered < total - 0.005;

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
        payment: { method },
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
          tendered: cash ? tendered : null,
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
        // повтор не создаст второй). Карту и QR ждём дольше: им без связи некуда.
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
      onPaid({ order: shown, offline, method, total, tendered: cash ? tendered : null, change: cash ? change : 0 });
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

  const canConfirm = !checkout.isPending && !short;
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
      if (cash && /^\d$/.test(e.key)) press(e.key);
      else if (cash && (e.key === "," || e.key === ".")) press(",");
      else if (cash && e.key === "Backspace") setText((c) => c.slice(0, -1));
      else if (e.key === "Enter") confirm();
      else if (e.key === "Escape") onClose();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cash, press, confirm, onClose]);

  const suggestions = useMemo(() => (cash ? cashSuggestions(total, fractionDigits) : []), [cash, total, fractionDigits]);
  const Icon = METHODS[method].icon;
  const totalParts = parts(total);

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !checkout.isPending && onClose()}>
      <div className="sh-modal" role="dialog" aria-label={`Оплата: ${METHODS[method].label}`}>
        <div className="sh-mh">
          <div className="emo">
            <Icon className="i" />
          </div>
          <div>
            <h3>{METHODS[method].label}</h3>
            <p>{offlineNow && cash ? "Нет связи — чек сохранится на кассе и уйдёт на сервер сам" : "Оплата чека"}</p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть" disabled={checkout.isPending}>
            <X className="i" />
          </button>
        </div>

        <div className="sh-pm-total">
          <div className="lbl">К оплате</div>
          <div className="v tab">
            {!totalParts.suffix && <small style={{ marginLeft: 0, marginRight: 8 }}>{totalParts.symbol}</small>}
            {totalParts.figure}
            {totalParts.suffix && <small>{totalParts.symbol}</small>}
          </div>
        </div>

        {cash ? (
          <>
            <div className="sh-pm-tender">
              <div className="row">
                <span className="lbl">Получено</span>
                <span className={`v tab${text === "" ? " ph" : ""}`}>
                  {parts(text ? parseDecimal(text) : total).figure}
                  <small style={{ fontWeight: 500, fontSize: 18, marginLeft: 8, color: "var(--muted)" }}>{totalParts.symbol}</small>
                </span>
              </div>
              <div className={`sh-pm-change${short ? " short" : ""}`}>
                <span>{short ? "Не хватает" : "Сдача"}</span>
                <b className="tab">{short ? money(total - (tendered ?? 0)) : money(change)}</b>
              </div>
            </div>

            <div className="sh-mb" style={{ gridTemplateColumns: "1fr 190px" }}>
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
              <div className="sh-qw">
                <div className="lbl">Клиент даёт</div>
                <button className={`tab${text === "" ? " on" : ""}`} onClick={() => setText("")}>
                  Ровно
                </button>
                {suggestions.map((sum) => (
                  <button key={sum} className="tab" onClick={() => setText(String(sum).replace(".", ","))}>
                    {money(sum)}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="sh-pm-note">
            <div className="sh-pm-icon">
              <Icon className="i" />
            </div>
            {method === "card" ? (
              <>
                Проведите оплату на <b>банковском терминале</b>.
                <br />
                Когда терминал напечатает чек об успешной оплате — подтвердите здесь.
              </>
            ) : (
              <>
                Клиент оплачивает по <b>QR-коду</b> в приложении банка.
                <br />
                Когда деньги пришли — подтвердите здесь.
              </>
            )}
          </div>
        )}

        <div className="sh-ma">
          <button className="cancel" onClick={onClose} disabled={checkout.isPending}>
            Отмена
          </button>
          <button className="ok" onClick={confirm} disabled={!canConfirm}>
            {checkout.isPending ? (
              <>
                <span className="sh-spin" /> Проводим…
              </>
            ) : (
              <>
                <Check className="i" />
                {cash ? "Принять оплату" : "Оплата получена"}
                {" · "}
                <span className="tab">{money(total)}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
