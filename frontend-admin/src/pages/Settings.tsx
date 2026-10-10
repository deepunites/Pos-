import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { settingsService } from "../services";
import LoadingSpinner from "../components/LoadingSpinner";
import toast from "react-hot-toast";
import { Save, Plus, X } from "lucide-react";
import { apiErrorMessage } from "../utils/apiError";

const DEFAULT_UNITS = [
  { key: "piece", label: "Штука" },
  { key: "kg", label: "Килограмм" },
  { key: "g", label: "Грамм" },
  { key: "l", label: "Литр" },
  { key: "ml", label: "Миллилитр" },
  { key: "portion", label: "Порция" },
];

type Unit = { key: string; label: string };

const tabs = [
  { id: "general", label: "Общие" },
  { id: "products", label: "Товары" },
];

export default function Settings() {
  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => settingsService.get().then((r) => r.data.data) });
  const [activeTab, setActiveTab] = useState("general");

  // General settings
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", timezone: "Asia/Tashkent", currency: "UZS", taxRate: 0, defaultMarkupPercent: 0 });

  // Product settings
  const [units, setUnits] = useState<Unit[]>(DEFAULT_UNITS);
  const [defaultUnit, setDefaultUnit] = useState("piece");
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [newUnitKey, setNewUnitKey] = useState("");
  const [catalogSharing, setCatalogSharing] = useState(true);

  // Форма редактируемая: при загрузке настроек с сервера её поля заполняются
  // один раз из ответа. Это синхронизация с внешними данными, а не производное
  // состояние, — исключение из правила осознанное (так же в Warehouse Pro).
  useEffect(() => {
    if (settings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- заполнение формы из ответа сервера
      setCatalogSharing(settings.catalogSharing !== false);
      setForm({ name: settings.name || "", phone: settings.phone || "", email: settings.email || "", address: settings.address || "", timezone: settings.timezone || "Asia/Tashkent", currency: settings.currency || "UZS", taxRate: Number(settings.taxRate) || 0, defaultMarkupPercent: Number(settings.defaultMarkupPercent) || 0 });
      try {
        const parsed = JSON.parse(settings.settings || "{}");
        if (parsed.units && Array.isArray(parsed.units) && parsed.units.length > 0) {
          setUnits(parsed.units);
        }
        if (parsed.defaultUnit) {
          setDefaultUnit(parsed.defaultUnit);
        }
      } catch {}
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => settingsService.update(data),
    onSuccess: () => toast.success("Настройки сохранены"),
    onError: (error) => toast.error(apiErrorMessage(error, "Ошибка")),
  });

  const handleAddUnit = () => {
    if (!newUnitLabel.trim() || !newUnitKey.trim()) return;
    if (units.some((u) => u.key === newUnitKey.trim())) {
      toast.error("Такой ключ уже существует");
      return;
    }
    setUnits([...units, { key: newUnitKey.trim(), label: newUnitLabel.trim() }]);
    setNewUnitLabel("");
    setNewUnitKey("");
  };

  const handleRemoveUnit = (key: string) => {
    setUnits(units.filter((u) => u.key !== key));
  };

  const handleSaveGeneral = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(form);
  };

  const handleSaveProducts = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({ settings: JSON.stringify({ units, defaultUnit }), catalogSharing });
  };

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold text-gray-900">Настройки</h1><p className="text-gray-500">Настройки вашего бизнеса</p></div>

      {/* На телефоне вкладки — строкой над содержимым, на широком экране — колонкой слева (D-4). */}
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <div className="md:w-56 md:flex-shrink-0">
          <nav className="-mx-3 flex gap-1 overflow-x-auto px-3 md:mx-0 md:block md:space-y-1 md:px-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium transition-colors md:w-full ${
                  activeTab === tab.id
                    ? "bg-primary-50 text-primary-700"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1 min-w-0">

      {activeTab === "general" && (
        <form onSubmit={handleSaveGeneral} className="space-y-6">
          {settings?.slug && (
            <div className="card space-y-3">
              <h2 className="text-lg font-semibold text-gray-900">Касса</h2>
              <p className="text-sm text-gray-500">
                Код точки вводится один раз при настройке планшета на кассе. После этого кассиры входят,
                нажав своё имя и набрав PIN, — PIN задаётся в разделе «Сотрудники».
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <code className="max-w-full break-all rounded-lg bg-gray-100 px-4 py-2.5 font-mono text-lg tracking-wide text-gray-900">{settings.slug}</code>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(settings.slug);
                      toast.success("Код скопирован");
                    } catch {
                      toast.error("Не удалось скопировать — выделите код вручную");
                    }
                  }}
                >
                  Копировать
                </button>
              </div>
            </div>
          )}
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Информация о бизнесе</h2>
            <div><label htmlFor="settings-f1" className="label">Название</label><input id="settings-f1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label htmlFor="settings-f2" className="label">Телефон</label><input id="settings-f2" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input" /></div>
              <div><label htmlFor="settings-f3" className="label">Email</label><input id="settings-f3" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input" /></div>
            </div>
            <div><label htmlFor="settings-f4" className="label">Адрес</label><textarea id="settings-f4" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="input min-h-[80px]" /></div>
          </div>
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Региональные</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="settings-f5" className="label">Часовой пояс</label>
                <select id="settings-f5" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className="input">
                  <option value="UTC">UTC</option>
                  <option value="Asia/Tashkent">Ташкент</option>
                  <option value="Asia/Dubai">Дубай</option>
                  <option value="Europe/Moscow">Москва</option>
                  <option value="Europe/London">Лондон</option>
                </select>
              </div>
              <div>
                <label htmlFor="settings-f6" className="label">Валюта</label>
                <select id="settings-f6" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="input">
                  <option value="USD">USD ($)</option>
                  <option value="UZS">UZS (сўм)</option>
                  <option value="RUB">RUB (₽)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
              <div><label htmlFor="settings-f7" className="label">Налог (%)</label><input id="settings-f7" type="number" step="0.01" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: parseFloat(e.target.value) || 0 })} className="input" /></div>
            </div>
          </div>
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Наценка</h2>
            <div>
              <label htmlFor="settings-f8" className="label">Наценка по умолчанию, %</label>
              <input id="settings-f8"
                type="number"
                step="0.1"
                min="0"
                value={form.defaultMarkupPercent}
                onChange={(e) => setForm({ ...form, defaultMarkupPercent: parseFloat(e.target.value) || 0 })}
                className="input"
              />
              <p className="mt-1 text-sm text-gray-500">
                Применяется к новым категориям, которые кассир создаёт прямо в терминале при оформлении прихода товара.
                Цена продажи считается как цена прихода × (1 + наценка / 100). Наценку отдельной категории можно задать на странице «Категории».
              </p>
              {form.defaultMarkupPercent <= 0 && (
                <p className="mt-2 rounded-lg bg-warning-50 px-3 py-2 text-sm text-warning-700">
                  Наценка 0% — цены продажи задаются вручную. Автоматический пересчёт при этом отключён:
                  иначе цена продажи стала бы равна себестоимости.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={updateMutation.isPending} className="btn-primary">
              {updateMutation.isPending ? "Сохранение..." : <><Save className="mr-2 h-4 w-4" />Сохранить настройки</>}
            </button>
          </div>
        </form>
      )}

      {activeTab === "products" && (
        <form onSubmit={handleSaveProducts} className="space-y-6">
          <div className="card space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">Общая база штрихкодов</h2>
            <p className="text-sm text-gray-500">
              Сканер узнаёт товары по общей базе: название, объём и полку подставляются сами, вводить остаётся только цену.
              База пополняется магазинами — товар, который вы добавили со штрихкодом, находят и другие.
            </p>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={catalogSharing} onChange={(e) => setCatalogSharing(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
              <span className="text-sm text-gray-700">
                Делиться с общей базой названиями моих товаров
                <span className="block text-xs text-gray-500">
                  Передаются только штрихкод, название и полка из стандартного списка. Цены, остатки, продажи и названия ваших категорий не передаются никогда.
                </span>
              </span>
            </label>
          </div>
          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Единицы измерения</h2>
            <p className="text-sm text-gray-500">Управьте единицами, которые доступны при добавлении товаров</p>
            <div>
              <label htmlFor="settings-f9" className="label">Единица по умолчанию</label>
              <select id="settings-f9" value={defaultUnit} onChange={(e) => setDefaultUnit(e.target.value)} className="input">
                {units.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              {units.map((u) => (
                <div key={u.key} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-2">
                  <div>
                    <span className="font-medium text-gray-900">{u.label}</span>
                    <span className="ml-2 text-sm text-gray-500">({u.key})</span>
                  </div>
                  <button type="button" onClick={() => handleRemoveUnit(u.key)} className="text-gray-500 hover:text-danger-500 transition-colors">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor="settings-f10" className="label">Название</label>
                <input id="settings-f10" value={newUnitLabel} onChange={(e) => setNewUnitLabel(e.target.value)} className="input" placeholder="Напр., Килограмм" />
              </div>
              <div className="flex-1">
                <label htmlFor="settings-f11" className="label">Ключ</label>
                <input id="settings-f11" value={newUnitKey} onChange={(e) => setNewUnitKey(e.target.value)} className="input" placeholder="Напр., kg" />
              </div>
              <button type="button" onClick={handleAddUnit} className="btn-primary mb-0.5">
                <Plus className="mr-1 h-4 w-4" />Добавить
              </button>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={updateMutation.isPending} className="btn-primary">
              {updateMutation.isPending ? "Сохранение..." : <><Save className="mr-2 h-4 w-4" />Сохранить</>}
            </button>
          </div>
        </form>
      )}
        </div>
      </div>
    </div>
  );
}
