import { useCallback, useEffect, useState } from "react";
import { Check, Delete, X } from "lucide-react";
import { parseDecimal } from "../../utils/weight";

interface NumberPadProps {
  title: string;
  emoji: string;
  imageUrl?: string | null;
  subtitle: string;
  /** "weight" takes kilograms with up to three decimals; "count" takes whole pieces. */
  mode: "weight" | "count";
  initial?: number;
  unitLabel: string;
  quick: number[];
  /** Line total for the typed value, shown under the number. */
  total: (value: number) => number;
  /** Most that may be sold (stock left), in the typed unit; Infinity when unlimited. */
  /** Больше нельзя (не задано — без предела: магазин продаёт в минус). */
  max?: number;
  maxHint?: string;
  confirmLabel: string;
  money: (n: number) => string;
  onConfirm: (value: number) => void;
  onClose: () => void;
}

const asText = (n: number | undefined, mode: "weight" | "count"): string =>
  n === undefined || n === 0 ? "" : mode === "count" ? String(Math.round(n)) : String(n).replace(".", ",");

/**
 * The one number-entry window of the register: the weight of a weighed product
 * (kilograms, three decimals) or the count of a piece product. The price of the
 * line is computed as it is typed, so the cashier can read it out to the customer.
 */
export default function NumberPad(props: NumberPadProps) {
  const { title, emoji, imageUrl, subtitle, mode, initial, unitLabel, quick, total, max = Number.POSITIVE_INFINITY, maxHint = "", confirmLabel, money, onConfirm, onClose } = props;
  const [text, setText] = useState(asText(initial, mode));
  // Editing an existing line opens with its value shown; the first key typed
  // replaces it (like a selected field) instead of tacking on to it — "1" then
  // "5" is 5 pieces, not 15.
  const [replaceNext, setReplaceNext] = useState(initial !== undefined && initial > 0);

  const value = parseDecimal(text);
  const tooMuch = value > max + 1e-9;
  const valid = mode === "count" ? Number.isInteger(value) && value >= 1 && value <= 99999 && !tooMuch : value > 0 && value <= 99999 && !tooMuch;

  const press = useCallback(
    (key: string) => {
      const replacing = replaceNext;
      if (replacing) setReplaceNext(false);
      setText((shown) => {
        const current = replacing ? "" : shown;
        if (key === ",") {
          if (mode === "count" || current.includes(",")) return current;
          return current === "" ? "0," : current + ",";
        }
        if (mode === "weight") {
          const [whole, frac] = current.split(",");
          if (frac !== undefined && frac.length >= 3) return current; // scales read to the gram
          if (frac === undefined && whole.length >= 5) return current;
          if (current === "0" && key !== "0") return key; // no leading zero: "05" → "5"
          if (current === "0" && key === "0") return current;
        } else {
          if (current.length >= 5) return current;
          if (current === "" && key === "0") return current;
        }
        return current + key;
      });
    },
    [mode, replaceNext]
  );
  const erase = useCallback(() => {
    setReplaceNext(false);
    setText((current) => current.slice(0, -1));
  }, []);
  const confirm = useCallback(() => {
    if (valid) onConfirm(value);
  }, [valid, value, onConfirm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "," || e.key === ".") press(",");
      else if (e.key === "Backspace") erase();
      else if (e.key === "Enter") confirm();
      else if (e.key === "Escape") onClose();
      else return;
      // stopPropagation alone leaves the browser's own action (typing the
      // character into whatever is focused) — that needs preventDefault.
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [press, erase, confirm, onClose]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const lineTotal = valid || value > 0 ? total(value) : 0;

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sh-modal" role="dialog" aria-label={title}>
        <div className="sh-mh">
          <div className="emo">{imageUrl ? <img src={imageUrl} alt="" /> : emoji}</div>
          <div>
            <h3>{title}</h3>
            <p className="tab">{subtitle}</p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>

        <div className="sh-wd">
          <div className="row">
            <span className="lbl">{mode === "weight" ? "Вес" : "Количество"}</span>
            <span className={`big tab${text === "" ? " ph" : ""}`}>
              {text || "0"}
              <small>{unitLabel}</small>
            </span>
          </div>
          <div className={`eq tab${tooMuch ? " bad" : ""}`}>
            <span>{tooMuch ? "больше, чем есть на складе" : mode === "weight" ? "цена × вес" : "цена × количество"}</span>
            {tooMuch ? maxHint : `= ${money(lineTotal)}`}
          </div>
        </div>

        <div className="sh-mb">
          <div className="sh-kp">
            {keys.map((k) => (
              <button key={k} onClick={() => press(k)}>
                {k}
              </button>
            ))}
            <button onClick={() => press(",")} disabled={mode === "count"} style={mode === "count" ? { opacity: 0.35 } : undefined}>
              ,
            </button>
            <button onClick={() => press("0")}>0</button>
            <button onClick={erase} aria-label="Стереть">
              <Delete className="i" />
            </button>
          </div>
          <div className="sh-qw">
            <div className="lbl">Быстро</div>
            {quick.map((q) => (
              <button
                key={q}
                className="tab"
                onClick={() => {
                  setReplaceNext(false);
                  setText(asText(q, mode));
                }}
              >
                {asText(q, mode)} {unitLabel}
              </button>
            ))}
          </div>
        </div>

        <div className="sh-ma">
          <button className="cancel" onClick={onClose}>
            Отмена
          </button>
          <button className="ok" onClick={confirm} disabled={!valid}>
            <Check className="i" />
            {confirmLabel}
            {valid && (
              <>
                {" · "}
                <span className="tab">{money(lineTotal)}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
