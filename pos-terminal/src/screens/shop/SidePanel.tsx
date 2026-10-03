import { Banknote, CornerDownLeft, CreditCard, Delete, QrCode, User, X } from "lucide-react";
import type { PaymentMethod } from "../../types";

interface SidePanelProps {
  total: number;
  positions: number;
  customerName?: string;
  parts: (amount: number) => { figure: string; symbol: string; suffix: boolean };
  armed: number | null;
  onDisarm: () => void;
  onKey: (key: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onMultiply: () => void;
  onEnter: () => void;
  onCustomer: () => void;
  onPay: (method: PaymentMethod) => void;
  canPay: boolean;
  /** Нет связи: картой и по QR не платят, только наличными (офлайн-режим). */
  offline?: boolean;
}

/** Total, the numeric keypad that feeds the scan field, and the three payment buttons. */
export default function SidePanel(props: SidePanelProps) {
  const { total, positions, customerName, parts, armed, onDisarm, onKey, onBackspace, onClear, onMultiply, onEnter, onCustomer, onPay, canPay, offline = false } = props;
  const { figure, symbol, suffix } = parts(total);

  return (
    <aside className="sh-side">
      <div className="sh-tot">
        <div className="lbl">К оплате</div>
        <div className="v tab">
          {!suffix && <small style={{ marginLeft: 0, marginRight: 8 }}>{symbol}</small>}
          {figure}
          {suffix && <small>{symbol}</small>}
        </div>
        <div className="m">
          <span>
            <b>{positions}</b> {positions === 1 ? "позиция" : positions >= 2 && positions <= 4 ? "позиции" : "позиций"}
          </span>
          <span>
            Клиент: <b>{customerName || "—"}</b>
          </span>
        </div>
      </div>

      <div className="sh-kd">
        <span className="lbl">Кол-во / вес для следующего</span>
        <span className="val tab">
          {armed ? (
            <>
              × {String(armed).replace(".", ",")}
              <button onClick={onDisarm} aria-label="Сбросить" title="Сбросить">
                <X className="i" style={{ width: 16, height: 16 }} />
              </button>
            </>
          ) : (
            <span style={{ color: "var(--faint)" }}>—</span>
          )}
        </span>
      </div>

      <div className="sh-pad">
        {["7", "8", "9"].map((k) => (
          <button key={k} onClick={() => onKey(k)}>
            {k}
          </button>
        ))}
        <button className="f" onClick={onBackspace} aria-label="Стереть">
          <Delete className="i" />
        </button>
        {["4", "5", "6"].map((k) => (
          <button key={k} onClick={() => onKey(k)}>
            {k}
          </button>
        ))}
        <button className="f" onClick={onClear} title="Очистить поле и множитель">
          C
        </button>
        {["1", "2", "3"].map((k) => (
          <button key={k} onClick={() => onKey(k)}>
            {k}
          </button>
        ))}
        <button className="f" onClick={onMultiply} title="Следующий товар — набранным количеством">
          ×
        </button>
        <button onClick={() => onKey("0")}>0</button>
        <button onClick={() => onKey("00")}>00</button>
        <button onClick={() => onKey(",")}>,</button>
        <button className="go" onClick={onEnter} aria-label="Ввод">
          <CornerDownLeft className="i" />
        </button>
      </div>

      <div className="sh-two">
        <button className={customerName ? "set" : ""} onClick={onCustomer}>
          <User className="i" />
          {customerName ? customerName : "Клиент"}
        </button>
      </div>

      <div className="sh-pay">
        <button className="sh-cash" onClick={() => onPay("cash")} disabled={!canPay}>
          <Banknote className="i" />
          Наличные
          <span className="sh-fk">F8</span>
        </button>
        <div className="sh-alts">
          <button className="sh-alt" onClick={() => onPay("card")} disabled={!canPay || offline} title={offline ? "Без связи — только наличные" : undefined}>
            <CreditCard className="i" />
            Карта
            <span className="sh-fk">F9</span>
          </button>
          <button className="sh-alt" onClick={() => onPay("qr")} disabled={!canPay || offline} title={offline ? "Без связи — только наличные" : undefined}>
            <QrCode className="i" />
            QR
            <span className="sh-fk">F10</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
