import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Banknote, Check, CreditCard, Minus, NotebookPen, Plus, ReceiptText, Search, Undo2, X } from "lucide-react";
import toast from "react-hot-toast";
import api from "../../services/api";
import { useMoney } from "../../hooks/useMoney";
import { apiErrorMessage } from "../../utils/apiError";
import { randomId } from "../../utils/id";
import { round2 } from "../../utils/money";
import { parseDecimal, pricePerKg } from "../../utils/weight";
import type { Product } from "../../types";
import { formatQty, productTitle, weightUnit } from "./shopProduct";

// Возврат на кассе. По чеку: найти продажу (номер, товар или список последних),
// отметить, что и сколько вернули, брак — галочкой. Без чека: отсканировать
// товар — сумма по текущей цене. Деньги — как решил кассир.

type Method = "cash" | "card" | "debt";

interface SaleLine {
  orderItemId: string;
  productId: string;
  name: string;
  weighed: boolean;
  sold: number;
  returned: number;
  left: number;
  lineTotal: number;
  leftAmount: number;
}

interface Sale {
  id: string;
  orderNumber: number;
  createdAt: string;
  total: number;
  returnedAmount: number;
  payments: { method: string; amount: number }[];
  customer: { id: string; firstName: string; lastName: string | null; debtBalance: number } | null;
  items: SaleLine[];
}

/** Строка возврата: из чека (line) или товар без чека (product). Штуки или граммы. */
interface ReturnLine {
  key: string;
  name: string;
  weighed: boolean;
  /** Сколько можно вернуть: штук или граммов; без чека — без предела. */
  max: number;
  /** Сумма за единицу (штуку или грамм). */
  rate: number;
  /** Вся оставшаяся сумма строки — чтобы «вернуть всё» было без копеек от округления. */
  leftAmount?: number;
  amount: number;
  text: string;
  defective: boolean;
  orderItemId?: string;
  productId?: string;
}

interface Done {
  number: number;
  amount: number;
  method: Method;
}

const METHOD_TEXT: Record<Method, string> = { cash: "наличными", card: "на карту", debt: "в счёт долга" };
const PAID_TEXT: Record<string, string> = { cash: "наличные", card: "карта", qr: "QR", debt: "в долг" };

const time = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? `сегодня ${hm}` : `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${hm}`;
};

function pickFromLine(line: SaleLine): ReturnLine {
  return {
    key: line.orderItemId,
    name: line.name,
    weighed: line.weighed,
    max: line.left,
    rate: line.left > 0 ? line.leftAmount / line.left : 0,
    leftAmount: line.leftAmount,
    amount: 0,
    text: "",
    defective: false,
    orderItemId: line.orderItemId,
  };
}

function pickFromProduct(p: Product): ReturnLine {
  const unit = weightUnit(p);
  return {
    key: `${p.id}-${randomId()}`,
    name: productTitle(p),
    weighed: unit !== null,
    max: Number.POSITIVE_INFINITY,
    rate: unit ? pricePerKg(Number(p.price), unit) / 1000 : Number(p.price),
    amount: unit ? 0 : 1,
    text: "",
    defective: false,
    productId: p.id,
  };
}

const lineSum = (p: ReturnLine) => (p.amount <= 0 ? 0 : p.leftAmount !== undefined && Math.abs(p.amount - p.max) < 0.0005 ? p.leftAmount : round2(p.rate * p.amount));

export default function ReturnModal({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const { money, parts } = useMoney();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"find" | "check" | "nocheck" | "done">("find");
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [picks, setPicks] = useState<ReturnLine[]>([]);
  const [method, setMethod] = useState<Method>("cash");
  const [done, setDone] = useState<Done | null>(null);
  // Один ключ на попытку: повтор после обрыва связи не вернёт деньги второй раз.
  const [key, setKey] = useState(randomId);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setTerm(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const sales = useQuery({
    queryKey: ["return-sales", term],
    queryFn: async () => (await api.get("/returns/sales", { params: term ? { q: term } : {} })).data.data as Sale[],
    enabled: mode === "find",
  });

  const products = useQuery({
    queryKey: ["return-products", term],
    queryFn: async () => (await api.get("/products", { params: { search: term, limit: 6, isActive: true, isIngredient: false, sort: "name" } })).data.data as Product[],
    enabled: mode === "nocheck" && term.length >= 2,
  });

  useEffect(() => {
    if (mode === "find" || mode === "nocheck") searchRef.current?.focus();
  }, [mode]);

  const openSale = (s: Sale) => {
    setSale(s);
    setPicks(s.items.filter((l) => l.left > 0).map(pickFromLine));
    setMethod("cash");
    setKey(randomId());
    setMode("check");
  };

  const startNoCheck = () => {
    setSale(null);
    setPicks([]);
    setMethod("cash");
    setQuery("");
    setKey(randomId());
    setMode("nocheck");
  };

  const back = () => {
    setSale(null);
    setPicks([]);
    setQuery("");
    setMode("find");
  };

  const addProduct = useCallback((p: Product) => {
    setPicks((list) => [...list, pickFromProduct(p)]);
    setQuery("");
  }, []);

  // Сканер в поле «без чека»: код целиком и Enter.
  const scan = async () => {
    const code = query.trim();
    if (!code) return;
    try {
      addProduct((await api.get("/products/lookup", { params: { code } })).data.data as Product);
    } catch {
      const first = products.data?.[0];
      if (first) addProduct(first);
      else toast.error(`Товар «${code}» не найден`);
    }
  };

  const update = (key: string, patch: Partial<ReturnLine>) => setPicks((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const setPieces = (p: ReturnLine, n: number) => update(p.key, { amount: Math.max(0, Math.min(p.max, n)) });
  const setKg = (p: ReturnLine, text: string) => {
    const grams = Math.round(parseDecimal(text) * 1000);
    update(p.key, { text, amount: Number.isFinite(grams) ? Math.max(0, grams) : 0 });
  };

  const chosen = picks.filter((p) => p.amount > 0);
  const tooMuch = chosen.some((p) => p.amount > p.max + 0.0005);
  const total = round2(chosen.reduce((sum, p) => sum + lineSum(p), 0));
  const debt = sale?.customer?.debtBalance ?? 0;
  const debtOk = method !== "debt" || (sale?.customer !== null && debt + 0.005 >= total);

  const submit = useMutation({
    mutationFn: async () =>
      (
        await api.post(
          "/returns",
          {
            orderId: sale?.id,
            cashShiftId: shiftId,
            method,
            items: chosen.map((p) => ({
              ...(p.orderItemId ? { orderItemId: p.orderItemId } : { productId: p.productId }),
              ...(p.weighed ? { grams: p.amount } : { quantity: p.amount }),
              defective: p.defective || undefined,
            })),
          },
          { headers: { "Idempotency-Key": `return-${key}` } }
        )
      ).data.data as Done,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cash-shift"] });
      qc.invalidateQueries({ queryKey: ["return-sales"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setDone(result);
      setMode("done");
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Возврат не прошёл — повторите"), { duration: 6000 }),
  });

  const canConfirm = chosen.length > 0 && !tooMuch && total > 0 && debtOk && !submit.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submit.isPending) {
        e.preventDefault();
        e.stopPropagation();
        if (mode === "check" || mode === "nocheck") back();
        else onClose();
      } else if (e.key === "Enter" && mode === "done") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const methods = useMemo(() => {
    const list: { id: Method; label: string; icon: typeof Banknote }[] = [
      { id: "cash", label: "Наличные", icon: Banknote },
      { id: "card", label: "На карту", icon: CreditCard },
    ];
    if (sale?.customer) list.push({ id: "debt", label: "В счёт долга", icon: NotebookPen });
    return list;
  }, [sale]);

  const totalParts = parts(total);

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !submit.isPending && onClose()}>
      <div className="sh-modal sh-rt" role="dialog" aria-label="Возврат">
        <div className="sh-mh">
          {mode === "check" || mode === "nocheck" ? (
            <button className="sh-pp-back" onClick={back} disabled={submit.isPending}>
              <ArrowLeft className="i" />
              Чеки
            </button>
          ) : (
            <div className="emo">
              <Undo2 className="i" />
            </div>
          )}
          <div>
            <h3>{mode === "check" && sale ? `Возврат по чеку №${sale.orderNumber}` : mode === "nocheck" ? "Возврат без чека" : mode === "done" ? "Возврат оформлен" : "Возврат"}</h3>
            <p>
              {mode === "check" && sale
                ? [time(sale.createdAt), money(sale.total), sale.payments.map((p) => PAID_TEXT[p.method] ?? p.method).join(" + "), sale.customer && `${sale.customer.firstName} · долг ${money(debt)}`]
                    .filter(Boolean)
                    .join(" · ")
                : mode === "nocheck"
                  ? "Отсканируйте товар — сумма по сегодняшней цене"
                  : mode === "done"
                    ? `№${done?.number}`
                    : "Номер чека, штрихкод или название товара из чека"}
            </p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть" disabled={submit.isPending}>
            <X className="i" />
          </button>
        </div>

        {mode === "find" && (
          <div className="sh-cu">
            <label className="sh-cu-search">
              <Search className="i" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sales.data?.length === 1) openSale(sales.data[0]);
                }}
                placeholder="Например, 128 или 4780000000113"
                aria-label="Номер чека, штрихкод или название"
              />
            </label>
            <div className="sh-cu-list" role="listbox" aria-label="Продажи">
              {(sales.data ?? []).map((s) => {
                const all = s.items.every((l) => l.left <= 0);
                return (
                  <button key={s.id} className={`sh-cu-row sh-rt-sale${all ? " off" : ""}`} onClick={() => openSale(s)} disabled={all} role="option" aria-selected={false}>
                    <span className="sh-rt-no tab">№{s.orderNumber}</span>
                    <span className="t">
                      <b>{s.items.map((l) => l.name).join(", ")}</b>
                      <small>
                        {time(s.createdAt)} · {s.payments.map((p) => PAID_TEXT[p.method] ?? p.method).join(" + ")}
                        {s.customer ? ` · ${s.customer.firstName}` : ""}
                      </small>
                    </span>
                    <span className="d">
                      <b className="tab">{money(s.total)}</b>
                      {s.returnedAmount > 0 && <span className="sh-rt-tag">{all ? "возвращён" : `возвращено ${money(s.returnedAmount)}`}</span>}
                    </span>
                  </button>
                );
              })}
              {sales.isLoading && <div className="sh-cu-empty">Ищем…</div>}
              {sales.isError && <div className="sh-cu-empty">Не удалось загрузить чеки — проверьте связь</div>}
              {sales.data?.length === 0 && <div className="sh-cu-empty">{term ? "Таких чеков нет — попробуйте номер чека или другое название" : "За три дня продаж нет"}</div>}
            </div>
            <button className="sh-cu-add" onClick={startNoCheck}>
              <ReceiptText className="i" />
              Возврат без чека
            </button>
          </div>
        )}

        {(mode === "check" || mode === "nocheck") && (
          <>
            {mode === "nocheck" && (
              <div className="sh-cu" style={{ marginBottom: 10 }}>
                <label className="sh-cu-search">
                  <Search className="i" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void scan();
                    }}
                    placeholder="Штрихкод или название"
                    aria-label="Штрихкод или название товара"
                  />
                </label>
                {term.length >= 2 && (products.data?.length ?? 0) > 0 && (
                  <div className="sh-cu-list" role="listbox" aria-label="Товары">
                    {products.data!.map((p) => (
                      <button key={p.id} className="sh-cu-row" onClick={() => addProduct(p)} role="option" aria-selected={false}>
                        <span className="t">
                          <b>{productTitle(p)}</b>
                          <small>{p.barcode ?? ""}</small>
                        </span>
                        <span className="d">
                          <b className="tab">
                            {money(weightUnit(p) ? pricePerKg(Number(p.price), weightUnit(p)!) : Number(p.price))}
                            {weightUnit(p) ? " /кг" : ""}
                          </b>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="sh-rt-lines">
              {picks.length === 0 && <div className="sh-cu-empty">{mode === "nocheck" ? "Отсканируйте возвращаемый товар" : "По этому чеку всё уже вернули"}</div>}
              {picks.map((p) => (
                <div key={p.key} className={`sh-rt-line${p.amount > 0 ? " on" : ""}`}>
                  <div className="t">
                    <b>{p.name}</b>
                    <small className="tab">
                      {mode === "check"
                        ? p.weighed
                          ? `можно вернуть ${formatQty(p.max / 1000)} кг · ${money(p.leftAmount ?? 0)}`
                          : `можно вернуть ${p.max} шт · ${money(p.leftAmount ?? 0)}`
                        : p.weighed
                          ? `${money(p.rate * 1000)} за кг`
                          : `${money(p.rate)} за шт`}
                    </small>
                  </div>
                  {p.weighed ? (
                    <label className="sh-rt-kg">
                      <input value={p.text} onChange={(e) => setKg(p, e.target.value.replace(/[^\d.,]/g, ""))} inputMode="decimal" placeholder="0,000" aria-label={`Вес, кг: ${p.name}`} />
                      кг
                    </label>
                  ) : (
                    <div className="sh-rt-qty">
                      <button onClick={() => setPieces(p, p.amount - 1)} disabled={p.amount <= 0} aria-label="Меньше">
                        <Minus className="i" />
                      </button>
                      <b className="tab">{p.amount}</b>
                      <button onClick={() => setPieces(p, p.amount + 1)} disabled={p.amount >= p.max} aria-label="Больше">
                        <Plus className="i" />
                      </button>
                    </div>
                  )}
                  <label className={`sh-rt-def${p.amount > 0 ? "" : " off"}`}>
                    <input type="checkbox" checked={p.defective} disabled={p.amount <= 0} onChange={(e) => update(p.key, { defective: e.target.checked })} />
                    брак
                  </label>
                  <b className={`sh-rt-sum tab${p.amount > p.max + 0.0005 ? " bad" : ""}`}>{p.amount > 0 ? money(lineSum(p)) : "—"}</b>
                </div>
              ))}
            </div>

            {mode === "check" && picks.length > 0 && (
              <button
                className="sh-rt-all"
                onClick={() => setPicks((list) => list.map((p) => ({ ...p, amount: p.max, text: p.weighed ? formatQty(p.max / 1000) : p.text })))}
              >
                Вернуть всё
              </button>
            )}

            <div className="sh-rt-foot">
              <div className="sh-rt-total">
                <span>К возврату</span>
                <b className="tab">
                  {totalParts.figure}
                  <small>{totalParts.symbol}</small>
                </b>
              </div>
              <div className="sh-pp-seg" style={{ gridTemplateColumns: `repeat(${methods.length}, 1fr)` }}>
                {methods.map((m) => (
                  <button key={m.id} className={method === m.id ? "on" : ""} onClick={() => setMethod(m.id)}>
                    <m.icon className="i" />
                    {m.label}
                  </button>
                ))}
              </div>
              {method === "debt" && !debtOk && <p className="sh-rt-warn">Долг клиента {money(debt)} — меньше суммы возврата. Верните деньгами.</p>}
              {tooMuch && <p className="sh-rt-warn">Вес больше, чем продали по чеку.</p>}
            </div>

            <div className="sh-ma">
              <button className="cancel" onClick={back} disabled={submit.isPending}>
                Назад
              </button>
              <button className="ok" onClick={() => canConfirm && submit.mutate()} disabled={!canConfirm}>
                {submit.isPending ? (
                  <>
                    <span className="sh-spin" /> Оформляем…
                  </>
                ) : total > 0 ? (
                  <>
                    <Undo2 className="i" />
                    Вернуть {money(total)} {METHOD_TEXT[method]}
                  </>
                ) : (
                  "Отметьте, что вернули"
                )}
              </button>
            </div>
          </>
        )}

        {mode === "done" && done && (
          <>
            <div className="sh-pm-total">
              <div className="lbl">{done.method === "cash" ? "Отдайте покупателю наличными" : done.method === "card" ? "Верните на карту покупателя" : "Долг клиента уменьшен на"}</div>
              <div className="v tab">
                {parts(done.amount).figure}
                <small>{parts(done.amount).symbol}</small>
              </div>
            </div>
            <div className="sh-ma">
              <button className="ok" onClick={onClose}>
                <Check className="i" />
                Готово
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
