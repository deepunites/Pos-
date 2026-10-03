import { useEffect, useState } from "react";
import { PauseCircle, Trash2, X } from "lucide-react";
import type { ParkedCheck } from "../../store/cartStore";
import { UZ_PREFIX, formatLocal, fullPhone, localDigits } from "../../utils/phone";

/** Escape closes any of these windows; the register's global keys are off while one is open. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

interface ParkedModalProps {
  parked: ParkedCheck[];
  hasCurrent: boolean;
  money: (amount: number) => string;
  onRestore: (id: string) => void;
  onDiscard: (id: string) => void;
  onClose: () => void;
}

const time = (ts: number): string => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function ParkedModal({ parked, hasCurrent, money, onRestore, onDiscard, onClose }: ParkedModalProps) {
  useEscape(onClose);
  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sh-modal narrow" role="dialog" aria-label="Отложенные чеки">
        <div className="sh-mh">
          <div className="emo">
            <PauseCircle className="i" />
          </div>
          <div>
            <h3>Отложенные чеки</h3>
            <p>{hasCurrent ? "Текущий чек тоже будет отложен" : "Верните чек, чтобы продолжить"}</p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>
        {parked.length === 0 ? (
          <div className="sh-empty" style={{ padding: "28px 0" }}>
            <b>Отложенных чеков нет</b>
            <small>«Отложить» (F2) убирает текущий чек в сторону — например, если клиент пошёл за ещё одним товаром</small>
          </div>
        ) : (
          <div className="sh-list">
            {parked.map((check) => {
              const total = check.items.reduce((sum, i) => sum + Math.round(i.price * i.quantity * 100) / 100, 0);
              return (
                <div className="sh-li" key={check.id}>
                  <div className="t">
                    <b className="tab">
                      {time(check.createdAt)} · {check.items.length} поз. · {money(total)}
                    </b>
                    <span>{check.items.map((i) => i.name).join(", ")}</span>
                  </div>
                  <button className="back" onClick={() => onRestore(check.id)}>
                    Вернуть
                  </button>
                  <button className="kill" onClick={() => onDiscard(check.id)} aria-label="Удалить" title="Удалить чек">
                    <Trash2 className="i" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface CustomerModalProps {
  name?: string;
  phone?: string;
  onSave: (name?: string, phone?: string) => void;
  onClose: () => void;
}

export function CustomerModal({ name = "", phone = "", onSave, onClose }: CustomerModalProps) {
  useEscape(onClose);
  const [n, setN] = useState(name);
  // Только девять цифр после +998: код страны касса ставит сама.
  const [p, setP] = useState(() => localDigits(phone));
  const [unfinished, setUnfinished] = useState(false);
  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="sh-modal narrow"
        role="dialog"
        aria-label="Клиент"
        onSubmit={(e) => {
          e.preventDefault();
          const full = fullPhone(p);
          if (full === null) return setUnfinished(true);
          onSave(n.trim() || undefined, full);
        }}
      >
        <div className="sh-mh">
          <div>
            <h3>Клиент</h3>
            <p>Имя и телефон попадут в чек</p>
          </div>
          <button type="button" className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>
        <label className="sh-field">
          <span>Имя</span>
          <input value={n} onChange={(e) => setN(e.target.value)} autoFocus />
        </label>
        <label className="sh-field">
          <span>Телефон</span>
          <div className="sh-phone">
            <b>{UZ_PREFIX}</b>
            <input
              value={formatLocal(p)}
              onChange={(e) => {
                setP(localDigits(e.target.value));
                setUnfinished(false);
              }}
              type="tel"
              inputMode="numeric"
              autoComplete="off"
              placeholder="90 123-45-67"
              aria-invalid={unfinished}
            />
          </div>
          {unfinished && <em className="sh-field-err">Допишите номер: после +998 нужно 9 цифр</em>}
        </label>
        <div className="sh-ma">
          <button type="button" className="cancel" onClick={() => onSave(undefined, undefined)}>
            Сбросить
          </button>
          <button type="submit" className="ok">
            Сохранить
          </button>
        </div>
      </form>
    </div>
  );
}
