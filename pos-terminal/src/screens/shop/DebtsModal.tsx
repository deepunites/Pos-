import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Banknote, Check, CreditCard, Delete, HandCoins, X } from "lucide-react";
import toast from "react-hot-toast";
import api from "../../services/api";
import { useMoney } from "../../hooks/useMoney";
import { apiErrorMessage } from "../../utils/apiError";
import { randomId } from "../../utils/id";
import { round2 } from "../../utils/money";
import { parseDecimal } from "../../utils/weight";
import CustomerPicker from "./CustomerPicker";
import NewCustomerModal from "./NewCustomerModal";
import { fullName, showPhone, type Customer } from "./customers";

interface DebtsModalProps {
  shiftId: string;
  onClose: () => void;
}

/**
 * «Долги» на кассе: клиент принёс деньги в счёт долга. Найти его, ввести
 * сумму, наличными или картой — погашение уходит в текущую смену.
 */
export default function DebtsModal({ shiftId, onClose }: DebtsModalProps) {
  const { money, parts, fractionDigits } = useMoney();
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [text, setText] = useState("");
  // Один ключ на попытку: повтор после обрыва связи не спишет долг второй раз.
  const [key, setKey] = useState(randomId);

  const debt = customer?.debtBalance ?? 0;
  const amount = text ? round2(parseDecimal(text)) : debt;
  const tooMuch = amount > debt + 0.005;
  const left = round2(debt - amount);

  const repay = useMutation({
    mutationFn: async () =>
      (
        await api.post(
          `/customers/${customer!.id}/repayments`,
          { amount, method, cashShiftId: shiftId },
          { headers: { "Idempotency-Key": `repay-${key}` } }
        )
      ).data.data as { customer: Customer },
    onSuccess: ({ customer: after }) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["cash-shift"] });
      toast.success(`${fullName(after)}: принято ${money(amount)} · долг ${money(after.debtBalance)}`, { duration: 5000 });
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Погашение не прошло — повторите"), { duration: 6000 }),
  });

  const canConfirm = customer !== null && amount > 0 && !tooMuch && !repay.isPending;
  const confirm = useCallback(() => {
    if (canConfirm) repay.mutate();
  }, [canConfirm, repay]);

  const press = useCallback(
    (k: string) =>
      setText((current) => {
        if (k === ",") return fractionDigits === 0 || current.includes(",") ? current : (current || "0") + ",";
        if (current.replace(",", "").length + k.length > 10 || (current === "" && /^0+$/.test(k))) return current;
        return current + k;
      }),
    [fractionDigits]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (adding) return;
      if (e.key === "Escape") onClose();
      else if (!customer) return;
      else if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setText((c) => c.slice(0, -1));
      else if (e.key === "Enter") confirm();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [adding, customer, press, confirm, onClose]);

  const quick = useMemo(() => {
    const step = fractionDigits === 0 ? [100_000, 50_000] : [100, 50];
    return step.filter((v) => v < debt);
  }, [debt, fractionDigits]);
  const debtParts = parts(debt);

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !repay.isPending && onClose()}>
      <div className="sh-modal" role="dialog" aria-label="Долги">
        <div className="sh-mh">
          {customer ? (
            <button
              className="sh-pp-back"
              onClick={() => {
                setCustomer(null);
                setText("");
              }}
            >
              <ArrowLeft className="i" />
              Клиенты
            </button>
          ) : (
            <div className="emo">
              <HandCoins className="i" />
            </div>
          )}
          <div>
            <h3>{customer ? "Погасить долг" : "Долги"}</h3>
            <p>{customer ? `${fullName(customer)} · ${showPhone(customer.phone)}` : "Найдите клиента — по цифрам телефона или имени"}</p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>

        {!customer && (
          <CustomerPicker
            debtorsOnly
            onPick={(c) => {
              setCustomer(c);
              setText("");
              setKey(randomId());
            }}
            onAdd={() => setAdding(true)}
          />
        )}

        {customer && (
          <>
            <div className="sh-pm-total">
              <div className="lbl">Долг клиента</div>
              <div className="v tab" style={{ color: "var(--amber-ink)" }}>
                {debtParts.figure}
                <small>{debtParts.symbol}</small>
              </div>
            </div>
            <div className="sh-pp-seg" style={{ marginBottom: 12 }}>
              <button className={method === "cash" ? "on" : ""} onClick={() => setMethod("cash")}>
                <Banknote className="i" />
                Наличные
              </button>
              <button className={method === "card" ? "on" : ""} onClick={() => setMethod("card")}>
                <CreditCard className="i" />
                Карта
              </button>
            </div>
            <div className="sh-pm-tender">
              <div className="row">
                <span className="lbl">Принимаем</span>
                <span className={`v tab${text === "" ? " ph" : ""}`}>
                  {parts(amount).figure}
                  <small style={{ fontWeight: 500, fontSize: 18, marginLeft: 8, color: "var(--muted)" }}>{debtParts.symbol}</small>
                </span>
              </div>
              <div className={`sh-pm-change${tooMuch ? " short" : ""}`}>
                <span>{tooMuch ? "Больше, чем долг" : "Останется долг"}</span>
                <b className="tab">{tooMuch ? money(amount - debt) : money(Math.max(0, left))}</b>
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
                <div className="lbl">Быстро</div>
                <button className={`tab${text === "" ? " on" : ""}`} onClick={() => setText("")}>
                  Весь долг
                </button>
                {quick.map((v) => (
                  <button key={v} className="tab" onClick={() => setText(String(v))}>
                    {money(v)}
                  </button>
                ))}
              </div>
            </div>
            <div className="sh-ma">
              <button className="cancel" onClick={onClose} disabled={repay.isPending}>
                Отмена
              </button>
              <button className="ok" onClick={confirm} disabled={!canConfirm}>
                {repay.isPending ? (
                  <>
                    <span className="sh-spin" /> Проводим…
                  </>
                ) : (
                  <>
                    <Check className="i" />
                    Принять {money(amount)} · в смену
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {adding && (
        <NewCustomerModal
          onCreated={(c) => {
            setAdding(false);
            setCustomer(c);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
