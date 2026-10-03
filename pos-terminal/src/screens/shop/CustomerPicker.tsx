import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, UserPlus } from "lucide-react";
import { useDebounced } from "../../hooks/useDebounced";
import { useMoney } from "../../hooks/useMoney";
import { LABEL_TEXT, fullName, initials, searchCustomers, showPhone, stars, type Customer } from "./customers";

interface CustomerPickerProps {
  onPick: (customer: Customer) => void;
  onAdd: () => void;
  /** Окно «Долги»: сразу показывать должников и не прятать заблокированных — им тоже гасить. */
  debtorsOnly?: boolean;
}

/**
 * Поиск клиента по последним цифрам телефона или по имени. Клиенту с меткой
 * «Не давать в долг» в долг продать нельзя — его строка неактивна (кроме окна
 * «Долги», где он гасит долг).
 */
export default function CustomerPicker({ onPick, onAdd, debtorsOnly = false }: CustomerPickerProps) {
  const { money } = useMoney();
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), 250);
  const { data: customers = [], isFetching, isError } = useQuery({
    queryKey: ["customers", search, debtorsOnly],
    queryFn: () => searchCustomers(search, debtorsOnly && !search),
    staleTime: 10_000,
  });

  return (
    <div className="sh-cu">
      <label className="sh-cu-search">
        <Search className="i" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Цифры телефона или имя"
          aria-label="Поиск клиента"
          autoFocus
          autoComplete="off"
        />
      </label>

      <div className="sh-cu-list" role="listbox" aria-label="Клиенты">
        {customers.map((c) => {
          const off = c.label === "blocked" && !debtorsOnly;
          return (
            <button key={c.id} className={`sh-cu-row${off ? " off" : ""}`} onClick={() => onPick(c)} disabled={off} role="option" aria-selected={false}>
              <span className={`sh-cu-av ${c.label}`}>{initials(c)}</span>
              <span className="t">
                <b>{fullName(c)}</b>
                <span>
                  {showPhone(c.phone)}
                  {c.rating ? <em className="sh-cu-stars">{stars(c.rating)}</em> : null}
                </span>
              </span>
              <span className="d">
                <small>долг</small>
                <b className={`tab ${c.label}`}>{money(c.debtBalance)}</b>
                <span className={`sh-cu-tag ${c.label}`}>{LABEL_TEXT[c.label]}</span>
              </span>
            </button>
          );
        })}
        {customers.length === 0 && (
          <div className="sh-cu-empty">
            {isError ? "Список клиентов не загрузился — проверьте связь" : isFetching ? "Ищем…" : search ? "Никого не нашли" : "Клиентов пока нет"}
          </div>
        )}
      </div>

      <button className="sh-cu-add" onClick={onAdd}>
        <UserPlus className="i" />
        Добавить клиента
      </button>
    </div>
  );
}
