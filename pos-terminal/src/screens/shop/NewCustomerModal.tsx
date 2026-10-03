import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import api from "../../services/api";
import { apiErrorMessage } from "../../utils/apiError";
import { UZ_PREFIX, formatLocal, fullPhone, localDigits } from "../../utils/phone";
import { useEscape } from "./Modals";
import type { Customer } from "./customers";

interface NewCustomerModalProps {
  onCreated: (customer: Customer) => void;
  onClose: () => void;
}

/** Новый клиент заведения: имя, фамилия, телефон и запасной. После сохранения он сразу выбран. */
export default function NewCustomerModal({ onCreated, onClose }: NewCustomerModalProps) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post("/customers", {
          firstName: firstName.trim(),
          lastName: lastName.trim() || undefined,
          phone: fullPhone(phone),
          phone2: fullPhone(phone2) || undefined,
        })
      ).data.data as Customer,
    onSuccess: (customer) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      onCreated(customer);
    },
    onError: (e) => setError(apiErrorMessage(e, "Клиент не сохранился — повторите")),
  });

  const submit = () => {
    if (!firstName.trim()) return setError("Введите имя");
    if (fullPhone(phone) == null) return setError("Телефон: после +998 нужно 9 цифр");
    if (fullPhone(phone2) === null) return setError("Запасной телефон: после +998 нужно 9 цифр — или оставьте пустым");
    setError(null);
    create.mutate();
  };

  const phoneField = (label: string, value: string, set: (v: string) => void, hint?: string) => (
    <label className="sh-field">
      <span>
        {label}
        {hint && <em> {hint}</em>}
      </span>
      <div className="sh-phone">
        <b>{UZ_PREFIX}</b>
        <input
          value={formatLocal(value)}
          onChange={(e) => {
            set(localDigits(e.target.value));
            setError(null);
          }}
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          placeholder="90 123-45-67"
        />
      </div>
    </label>
  );

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="sh-modal narrow"
        role="dialog"
        aria-label="Новый клиент"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="sh-mh">
          <div className="emo">
            <UserPlus className="i" />
          </div>
          <div>
            <h3>Новый клиент</h3>
            <p>Сохранится в списке клиентов магазина</p>
          </div>
          <button type="button" className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>
        <div className="sh-cu-two">
          <label className="sh-field">
            <span>Имя *</span>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
          </label>
          <label className="sh-field">
            <span>Фамилия</span>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
        </div>
        {phoneField("Телефон *", phone, setPhone)}
        {phoneField("Запасной телефон", phone2, setPhone2, "— если есть")}
        {error && <em className="sh-field-err">{error}</em>}
        <div className="sh-ma">
          <button type="button" className="cancel" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="ok" disabled={create.isPending}>
            {create.isPending ? "Сохраняем…" : "Сохранить и выбрать"}
          </button>
        </div>
      </form>
    </div>
  );
}
