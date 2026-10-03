import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import toast from "react-hot-toast";
import { AlertTriangle, Ban, HandCoins, Pencil, Users as UsersIcon, UserPlus, Wallet } from "lucide-react";
import clsx from "clsx";
import { customerService, type Customer, type CustomerDebtEntry, type DebtLabel } from "../services";
import { useMoney } from "../hooks/useMoney";
import { apiErrorMessage } from "../utils/apiError";
import { UZ_PREFIX, formatLocal, fullPhone, localDigits } from "../utils/phone";
import Badge from "../components/Badge";
import Modal from "../components/Modal";
import SearchInput from "../components/SearchInput";
import StatsCard from "../components/StatsCard";
import EmptyState from "../components/EmptyState";
import LoadingSpinner from "../components/LoadingSpinner";

// Клиенты заведения и их долги: касса продаёт в долг и принимает погашения,
// здесь — общий список, история, ручная оценка и запрет давать в долг.

const LABEL: Record<DebtLabel, { text: string; variant: "success" | "warning" | "danger" }> = {
  ok: { text: "Надёжный", variant: "success" },
  warn: { text: "Внимание", variant: "warning" },
  blocked: { text: "Не давать в долг", variant: "danger" },
};

const fullName = (c: Pick<Customer, "firstName" | "lastName">) => [c.firstName, c.lastName].filter(Boolean).join(" ");
const showPhone = (phone: string) => `${UZ_PREFIX} ${formatLocal(localDigits(phone))}`;
const stars = (rating?: number | null) => (rating ? "★".repeat(rating) + "☆".repeat(5 - rating) : "—");

function debtNote(c: Customer): string {
  if (c.debtBalance <= 0.005) return "без долга";
  if (c.debtDays >= 1) return `долг висит ${c.debtDays} дн.`;
  return "долг с сегодня";
}

function entryText(e: CustomerDebtEntry): string {
  const check = e.order ? `чек №${e.order.orderNumber}` : "чек";
  if (e.type === "sale") return `${check} · в долг`;
  if (e.type === "refund") return `возврат · ${check}`;
  return `погашение · ${e.method === "card" ? "карта" : "наличные"} · ${e.cashShiftId ? "касса" : "админка"}`;
}

export default function Customers() {
  const { money } = useMoney();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [onlyDebt, setOnlyDebt] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [repaying, setRepaying] = useState(false);

  const { data: summary } = useQuery({ queryKey: ["customers-summary"], queryFn: () => customerService.summary().then((r) => r.data.data) });
  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["customers", search, onlyDebt],
    queryFn: () => customerService.list({ search: search || undefined, withDebt: onlyDebt || undefined, limit: 200 }).then((r) => r.data.data),
  });
  const { data: selected } = useQuery({
    queryKey: ["customer", selectedId],
    queryFn: () => customerService.get(selectedId!).then((r) => r.data.data),
    enabled: Boolean(selectedId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customers-summary"] });
    qc.invalidateQueries({ queryKey: ["customer"] });
  };

  const patch = useMutation({
    mutationFn: (data: { rating?: number | null; note?: string | null; debtBlocked?: boolean }) => customerService.update(selectedId!, data),
    onSuccess: refresh,
    onError: (error) => toast.error(apiErrorMessage(error, "Не сохранилось")),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Клиенты</h1>
          <p className="text-gray-500">Покупатели магазина и их долги</p>
        </div>
        <button onClick={() => setEditing("new")} className="btn-primary">
          <UserPlus className="mr-2 h-4 w-4" />
          Новый клиент
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatsCard title="Всего в долг" value={money(summary?.totalDebt ?? 0)} icon={<Wallet className="h-6 w-6" />} />
        <StatsCard title="Должников" value={summary ? `${summary.debtors} из ${summary.customers}` : "—"} icon={<UsersIcon className="h-6 w-6" />} />
        <StatsCard
          title="Просрочено больше 30 дней"
          value={money(summary?.overdueDebt ?? 0)}
          icon={<AlertTriangle className="h-6 w-6" />}
          color={summary && summary.overdueDebt > 0 ? "red" : "blue"}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="card overflow-hidden p-0">
          <div className="flex flex-wrap gap-3 p-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Имя или цифры телефона" className="min-w-0 flex-1" />
            <select value={onlyDebt ? "debt" : "all"} onChange={(e) => setOnlyDebt(e.target.value === "debt")} className="input w-44" aria-label="Кого показать">
              <option value="debt">Только с долгом</option>
              <option value="all">Все клиенты</option>
            </select>
          </div>
          {isLoading ? (
            <LoadingSpinner />
          ) : customers.length === 0 ? (
            <EmptyState
              compact
              icon={<UsersIcon className="h-8 w-8" />}
              title={onlyDebt && !search ? "Должников нет" : "Никого не нашли"}
              description={onlyDebt && !search ? "Клиентов с долгом пока нет — переключите на «Все клиенты»." : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="p-4">Клиент</th>
                    <th className="p-4">Телефон</th>
                    <th className="p-4 text-right">Долг</th>
                    <th className="p-4">Оценка</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {customers.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={clsx("cursor-pointer border-b border-gray-100 hover:bg-gray-50", c.id === selectedId && "bg-primary-50/60")}
                    >
                      <td className="p-4">
                        <div className="font-medium text-gray-900">{fullName(c)}</div>
                        <div className="text-xs text-gray-500">{debtNote(c)}</div>
                      </td>
                      <td className="p-4 whitespace-nowrap text-gray-700">{showPhone(c.phone)}</td>
                      <td className={clsx("p-4 text-right font-semibold whitespace-nowrap", c.label === "blocked" ? "text-danger-600" : c.debtBalance > 0 ? "text-warning-800" : "text-gray-500")}>
                        {money(c.debtBalance)}
                      </td>
                      <td className="p-4">
                        <div className="text-warning-600 tracking-wider">{stars(c.rating)}</div>
                        <Badge variant={LABEL[c.label].variant}>{LABEL[c.label].text}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card space-y-4">
          {!selected ? (
            <EmptyState compact icon={<HandCoins className="h-8 w-8" />} title="Выберите клиента" description="Здесь будут его долг, история и оценка." />
          ) : (
            <CustomerCard
              key={selected.id}
              customer={selected}
              money={money}
              busy={patch.isPending}
              onEdit={() => setEditing(selected)}
              onRepay={() => setRepaying(true)}
              onPatch={(data) => patch.mutate(data)}
            />
          )}
        </div>
      </div>

      {editing && (
        <CustomerForm
          customer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            setSelectedId(c.id);
            refresh();
          }}
        />
      )}
      {repaying && selected && (
        <RepayModal
          customer={selected}
          money={money}
          onClose={() => setRepaying(false)}
          onDone={() => {
            setRepaying(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CustomerCard({
  customer: c,
  money,
  busy,
  onEdit,
  onRepay,
  onPatch,
}: {
  customer: Customer & { history: CustomerDebtEntry[] };
  money: (n: number) => string;
  busy: boolean;
  onEdit: () => void;
  onRepay: () => void;
  onPatch: (data: { rating?: number | null; note?: string | null; debtBlocked?: boolean }) => void;
}) {
  // Карточка пересоздаётся на каждого клиента (key), поэтому заметка берётся один раз.
  const [note, setNote] = useState(c.note ?? "");

  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-bar-active text-sm font-semibold text-white">
          {`${c.firstName[0] ?? ""}${c.lastName?.[0] ?? ""}`.toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{fullName(c)}</h2>
          <p className="text-sm text-gray-500">{showPhone(c.phone)}</p>
          {c.phone2 && <p className="text-sm text-gray-500">запасной {showPhone(c.phone2)}</p>}
        </div>
        <button onClick={onEdit} className="rounded p-2 text-gray-500 hover:bg-gray-100" aria-label="Изменить данные клиента">
          <Pencil className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md bg-warning-50 p-3">
          <p className="text-xs text-gray-500">Долг</p>
          <p className="text-2xl font-bold text-warning-800">{money(c.debtBalance)}</p>
        </div>
        <div className="rounded-md bg-gray-50 p-3">
          <p className="text-xs text-gray-500">Метка (ставится сама)</p>
          <div className="mt-1">
            <Badge variant={LABEL[c.label].variant}>{LABEL[c.label].text}</Badge>
          </div>
          <p className="mt-1 text-xs text-gray-500">{c.debtBlocked ? "запрет поставлен вручную" : debtNote(c)}</p>
        </div>
      </div>

      <div>
        <p className="label">Ваша оценка и заметка</p>
        <div className="flex gap-1" role="radiogroup" aria-label="Оценка клиента">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={c.rating === n}
              aria-label={`${n} из 5`}
              disabled={busy}
              onClick={() => onPatch({ rating: c.rating === n ? null : n })}
              className={clsx("text-2xl leading-none", (c.rating ?? 0) >= n ? "text-warning-500" : "text-gray-300 hover:text-warning-400")}
            >
              ★
            </button>
          ))}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (c.note ?? "") && onPatch({ note: note.trim() || null })}
          placeholder="Например: берёт в пятницу, отдаёт в понедельник"
          className="input mt-2"
          maxLength={500}
          aria-label="Заметка о клиенте"
        />
      </div>

      <div>
        <p className="mb-1 text-sm font-semibold text-gray-700">История</p>
        {c.history.length === 0 ? (
          <p className="text-sm text-gray-500">Пока ничего: в долг не брал.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto text-sm">
            {c.history.map((e) => (
              <div key={e.id} className="flex justify-between gap-3 border-b border-gray-100 py-1.5">
                <span className="text-gray-700">
                  <span className="text-gray-500">{format(new Date(e.createdAt), "d MMM, HH:mm", { locale: ru })}</span> · {entryText(e)}
                </span>
                <b className={clsx("whitespace-nowrap", e.amount > 0 ? "text-warning-800" : "text-success-700")}>
                  {e.amount > 0 ? "+" : "−"}
                  {money(Math.abs(e.amount))}
                </b>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={onRepay} disabled={c.debtBalance <= 0.005} className="btn-primary flex-1">
          <HandCoins className="mr-2 h-4 w-4" />
          Принять оплату долга
        </button>
        <button onClick={() => onPatch({ debtBlocked: !c.debtBlocked })} disabled={busy} className="btn-secondary">
          <Ban className="mr-2 h-4 w-4" />
          {c.debtBlocked ? "Снова давать в долг" : "Не давать в долг"}
        </button>
      </div>
    </>
  );
}

function PhoneInput({ label, value, onChange, id }: { label: string; value: string; onChange: (v: string) => void; id: string }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="flex">
        <span className="flex items-center rounded-l-md border border-r-0 border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">{UZ_PREFIX}</span>
        <input
          id={id}
          value={formatLocal(value)}
          onChange={(e) => onChange(localDigits(e.target.value))}
          className="input rounded-l-none"
          inputMode="numeric"
          placeholder="90 123-45-67"
          autoComplete="off"
        />
      </div>
    </div>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: (c: Customer) => void }) {
  const [firstName, setFirstName] = useState(customer?.firstName ?? "");
  const [lastName, setLastName] = useState(customer?.lastName ?? "");
  const [phone, setPhone] = useState(localDigits(customer?.phone ?? ""));
  const [phone2, setPhone2] = useState(localDigits(customer?.phone2 ?? ""));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const data = { firstName: firstName.trim(), lastName: lastName.trim() || null, phone: fullPhone(phone)!, phone2: fullPhone(phone2) ?? null };
      const res = customer ? await customerService.update(customer.id, data) : await customerService.create({ ...data, lastName: data.lastName ?? undefined, phone2: data.phone2 ?? undefined });
      return res.data.data;
    },
    onSuccess: (c) => {
      toast.success(customer ? "Клиент сохранён" : "Клиент добавлен");
      onSaved(c);
    },
    onError: (e) => setError(apiErrorMessage(e, "Не сохранилось")),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return setError("Введите имя");
    if (fullPhone(phone) == null) return setError("Телефон: после +998 нужно 9 цифр");
    if (fullPhone(phone2) === null) return setError("Запасной телефон: после +998 нужно 9 цифр — или оставьте пустым");
    setError(null);
    save.mutate();
  };

  return (
    <Modal isOpen onClose={onClose} title={customer ? "Клиент" : "Новый клиент"} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="customer-first" className="label">
              Имя *
            </label>
            <input id="customer-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input" />
          </div>
          <div>
            <label htmlFor="customer-last" className="label">
              Фамилия
            </label>
            <input id="customer-last" value={lastName} onChange={(e) => setLastName(e.target.value)} className="input" />
          </div>
        </div>
        <PhoneInput id="customer-phone" label="Телефон *" value={phone} onChange={setPhone} />
        <PhoneInput id="customer-phone2" label="Запасной телефон — если есть" value={phone2} onChange={setPhone2} />
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-secondary">
            Отмена
          </button>
          <button type="submit" disabled={save.isPending} className="btn-primary">
            {save.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RepayModal({ customer, money, onClose, onDone }: { customer: Customer; money: (n: number) => string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(customer.debtBalance));
  const [method, setMethod] = useState<"cash" | "card">("cash");
  // Один ключ на окно: двойной клик или повтор после обрыва не спишут дважды.
  const [key] = useState(() => `admin-repay-${customer.id}-${Date.now()}`);
  const value = Number(amount.replace(",", ".")) || 0;
  const tooMuch = value > customer.debtBalance + 0.005;

  const repay = useMutation({
    mutationFn: () => customerService.repay(customer.id, { amount: value, method }, key),
    onSuccess: () => {
      toast.success(`Принято ${money(value)}`);
      onDone();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Погашение не прошло")),
  });

  return (
    <Modal isOpen onClose={onClose} title={`Оплата долга · ${fullName(customer)}`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Долг клиента: <b className="text-warning-800">{money(customer.debtBalance)}</b>. Деньги, принятые здесь, не попадают в смену кассы.
        </p>
        <div>
          <label htmlFor="repay-amount" className="label">
            Сумма
          </label>
          <div className="flex gap-2">
            <input id="repay-amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" inputMode="decimal" />
            <button type="button" onClick={() => setAmount(String(customer.debtBalance))} className="btn-secondary whitespace-nowrap">
              Весь долг
            </button>
          </div>
          {tooMuch && <p className="mt-1 text-sm text-danger-600">Больше, чем долг клиента</p>}
        </div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Как платит">
          {(["cash", "card"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={clsx("rounded-md border-2 p-3 text-sm font-semibold", method === m ? "border-primary-600 bg-primary-50" : "border-gray-200")}
            >
              {m === "cash" ? "Наличные" : "Карта"}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-secondary">
            Отмена
          </button>
          <button type="button" onClick={() => repay.mutate()} disabled={value <= 0 || tooMuch || repay.isPending} className="btn-primary">
            {repay.isPending ? "Проводим…" : `Принять ${money(value)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
