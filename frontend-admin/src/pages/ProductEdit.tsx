import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Save, ChefHat, Plus, ExternalLink, ScanBarcode, Camera, History } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import toast from "react-hot-toast";
import { useProduct, useCreateProduct, useUpdateProduct, useCategories } from "../hooks/useProducts";
import { useTechCards } from "../hooks/useTechCards";
import { settingsService, stockReceiptService } from "../services";
import BarcodeCamera from "../components/BarcodeCamera";
import { lookupBarcode } from "../utils/barcodeLookup";
import LoadingSpinner from "../components/LoadingSpinner";
import Checkbox from "../components/Checkbox";
import { useMoney } from "../hooks/useMoney";
import type { ProductInput, TechCardItem } from "../services";

// Быстрые кнопки на кассе магазина — товары с этим тегом.
const QUICK_TAG = "quick";

function parseTags(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export default function ProductEdit() {
  const { money } = useMoney();
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  const { data: product, isLoading } = useProduct(id || "");
  const { data: categories } = useCategories();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => settingsService.get().then((r) => r.data.data) });
  // Магазин: без категории, цеха и метода приготовления — это поля кафе.
  const retail = settings?.businessType === "retail";
  const { data: lastSupply } = useQuery({
    queryKey: ["last-supply", id],
    queryFn: () => stockReceiptService.lastSupply([id!]).then((r) => r.data.data[id!] ?? null),
    enabled: !isNew,
  });
  const [scanning, setScanning] = useState(false);
  const barcodeRef = useRef<HTMLInputElement>(null);
  const { data: techCardsData } = useTechCards({ limit: 100 });
  const techCardsList = techCardsData || [];

  let defaultUnit = "piece";
  try {
    const parsed = JSON.parse(settings?.settings || "{}");
    if (parsed.defaultUnit) {
      defaultUnit = parsed.defaultUnit;
    }
  } catch {}
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const defaultUnitRef = useState(defaultUnit);
  const stableDefaultUnit = defaultUnitRef[0];

  const [form, setForm] = useState({
    name: "", description: "", volume: "", volumeType: "liter" as "liter" | "gram",
    sku: "", barcode: "", price: 0, costPrice: 0,
    compareAtPrice: 0, taxRate: 0, unit: "piece",
    purchaseUnit: "", saleUnit: "", conversionFactor: undefined as number | undefined,
    purchaseCost: 0,
    minStock: 0, currentStock: 0,
    trackInventory: false, categoryId: "", imageUrl: "", isActive: true,
    isIngredient: false,
    techCardId: "" as string,
    preparationArea: "",
    cookingMethod: "",
    noDiscounts: false,
    quick: false,
  });
  // Теги, которых нет на форме, сохраняются как были — форма управляет только «quick».
  const [otherTags, setOtherTags] = useState<string[]>([]);

  const getConversionFactor = (purchase: string, sale: string): number | undefined => {
    const conversions: Record<string, Record<string, number>> = {
      "кг": { "г": 1000 },
      "л": { "мл": 1000 },
      "упаковка": { "г": 1000, "мл": 1000 },
    };
    return conversions[purchase]?.[sale];
  };

  const loadedProductIdRef = useRef<string | null>(null);
  // The IKPU code the catalogue brought along when the product was added by scanning.
  const ikpu = (() => {
    try {
      const value = JSON.parse(product?.metadata || "{}").ikpu;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  })();

  useEffect(() => {
    if (product && loadedProductIdRef.current !== product.id) {
      loadedProductIdRef.current = product.id;
      const vol = product.volume || "";
      const isGram = vol.includes("г") || vol.includes("g");
      const purchaseUnit = product.purchaseUnit || "";
      const saleUnit = product.saleUnit || "";
      const conversionFactor = product.conversionFactor ?? undefined;
      const costPrice = Number(product.costPrice) || 0;
      const purchaseCost = conversionFactor ? costPrice * conversionFactor : 0;
      setForm({
        name: product.name || "", description: product.description || "", volume: vol,
        volumeType: isGram ? "gram" : "liter",
        sku: product.sku || "", barcode: product.barcode || "", price: Number(product.price) || 0, costPrice,
        compareAtPrice: Number(product.compareAtPrice) || 0, taxRate: Number(product.taxRate) || 0,
        unit: product.unit || "piece",
        purchaseUnit,
        saleUnit,
        conversionFactor,
        purchaseCost,
        // Остатки в килограммах ведутся до грамма: старые значения вида 82.96000000000001 показываем как 82.96.
        minStock: Math.round((product.minStock || 0) * 1000) / 1000, currentStock: Math.round((product.currentStock || 0) * 1000) / 1000,
        trackInventory: product.trackInventory || false, categoryId: product.categoryId || "",
        imageUrl: product.imageUrl || "", isActive: product.isActive ?? true,
        isIngredient: product.isIngredient || false,
        techCardId: product.techCardId || "",
        preparationArea: product.preparationArea || "",
        cookingMethod: product.cookingMethod || "",
        noDiscounts: product.noDiscounts || false,
        quick: parseTags(product.tags).includes(QUICK_TAG),
      });
      setOtherTags(parseTags(product.tags).filter((t) => t !== QUICK_TAG));
    }
  }, [product]);

  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (isNew && settings && !settingsLoadedRef.current) {
      settingsLoadedRef.current = true;
      // У магазина остатки учитываются сразу: количество — начальный остаток.
      setForm((prev) => ({ ...prev, unit: stableDefaultUnit, trackInventory: prev.trackInventory || settings.businessType === "retail" }));
    }
  }, [isNew, settings, stableDefaultUnit]);

  if (!isNew && isLoading) return <LoadingSpinner />;

  // Отсканировали (сканером в поле или камерой) — название подтянется из базы штрихкодов.
  const applyBarcode = async (raw: string) => {
    const code = raw.replace(/\s/g, "");
    setForm((prev) => ({ ...prev, barcode: code }));
    if (!code) return;
    try {
      const hit = await lookupBarcode(code);
      if (hit.product && hit.product.id !== id) {
        toast.error(`Этот штрихкод уже у товара «${hit.product.name}»`);
      } else if (hit.name) {
        setForm((prev) => (prev.name.trim() ? prev : { ...prev, name: hit.name! }));
        toast.success("Название — из базы штрихкодов", { duration: 2000 });
      }
    } catch {
      // без связи с базой штрихкодов название вводят вручную
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const { purchaseCost: _purchaseCost, volumeType: _volumeType, quick, ...submitForm } = form;
    const submitData: ProductInput = {
      ...submitForm,
      techCardId: form.techCardId || null,
      tags: quick ? [...otherTags, QUICK_TAG] : otherTags,
    };
    if (isNew) {
      createProduct.mutate(submitData, { onSuccess: () => navigate("/products") });
    } else {
      updateProduct.mutate({ id: id!, data: submitData }, { onSuccess: () => navigate("/products") });
    }
  };

  const isPending = createProduct.isPending || updateProduct.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate("/products")} aria-label="Назад к товарам" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><ArrowLeft className="h-5 w-5" /></button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{isNew ? "Новый товар" : "Редактирование товара"}</h1>
          <p className="text-gray-500">{isNew ? "Создайте новый товар" : "Обновите данные товара"}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Основная информация</h2>
          {retail && (
            <div>
              <label htmlFor="productedit-barcode" className="label">Штрихкод</label>
              <div className="flex gap-2">
                <input
                  id="productedit-barcode"
                  ref={barcodeRef}
                  type="text"
                  inputMode="numeric"
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void applyBarcode(form.barcode);
                    }
                  }}
                  onBlur={() => form.barcode && !form.name.trim() && void applyBarcode(form.barcode)}
                  className="input"
                  placeholder="Отсканируйте или введите"
                />
                <button type="button" onClick={() => barcodeRef.current?.focus()} className="btn-secondary whitespace-nowrap" title="Сканер штрихкодов «печатает» код в поле">
                  <ScanBarcode className="mr-2 h-4 w-4" />
                  Сканер
                </button>
                <button type="button" onClick={() => setScanning(true)} className="btn-secondary whitespace-nowrap">
                  <Camera className="mr-2 h-4 w-4" />
                  Камера
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Название подставится из базы штрихкодов.
                {ikpu && (
                  <>
                    {" "}ИКПУ: <span className="font-mono text-gray-700">{ikpu}</span>
                  </>
                )}
              </p>
            </div>
          )}
          <div>
            <label htmlFor="productedit-f1" className="label">Название товара *</label>
            <input id="productedit-f1" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder={retail ? "Напр., Сок яблочный 1 л" : "Напр., Классический бургер"} required />
          </div>
          <div>
            <label htmlFor="productedit-f2" className="label">Описание</label>
            <textarea id="productedit-f2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input min-h-[80px]" placeholder="Описание товара..." />
          </div>
          <div className="space-y-3">
            <p id="productedit-volume" className="label">Объем / Граммовка</p>
            <div role="group" aria-labelledby="productedit-volume" className="flex gap-2">
              <button
                type="button"
                aria-pressed={form.volumeType === "liter"}
                onClick={() => setForm({ ...form, volumeType: "liter", volume: "" })}
                className={`rounded px-5 py-2.5 text-sm font-semibold transition-colors ${
                  form.volumeType === "liter" ? "bg-action text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Объем
              </button>
              <button
                type="button"
                aria-pressed={form.volumeType === "gram"}
                onClick={() => setForm({ ...form, volumeType: "gram", volume: "" })}
                className={`rounded px-5 py-2.5 text-sm font-semibold transition-colors ${
                  form.volumeType === "gram" ? "bg-action text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Граммы
              </button>
            </div>
            {form.volumeType === "liter" ? (
              <select aria-label="Объём" value={form.volume} onChange={(e) => setForm({ ...form, volume: e.target.value })} className="input">
                <option value="">Без объема</option>
                <option value="0.5 л">0.5 л</option>
                <option value="0.7 л">0.7 л</option>
                <option value="1 л">1 л</option>
                <option value="1.5 л">1.5 л</option>
                <option value="2 л">2 л</option>
              </select>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  aria-label="Граммовка"
                  value={form.volume}
                  onChange={(e) => setForm({ ...form, volume: e.target.value })}
                  className="input"
                  placeholder="Введите граммовку..."
                />
                <div className="flex flex-wrap gap-2">
                  {["30 г", "50 г", "100 г", "200 г", "500 г", "1 кг"].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setForm({ ...form, volume: g })}
                      aria-pressed={form.volume === g}
                      className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                        form.volume === g
                          ? "bg-action text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {!retail && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="productedit-f3" className="label">Категория</label>
              <select id="productedit-f3" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} className="input">
                <option value="">Без категории</option>
                {categories?.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="productedit-f4" className="label">Цех приготовления</label>
              <select id="productedit-f4" value={form.preparationArea} onChange={(e) => setForm({ ...form, preparationArea: e.target.value })} className="input">
                <option value="">Не указан</option>
                <option value="Кухня">Кухня</option>
                <option value="Бар">Бар</option>
                <option value="Гриль">Гриль</option>
                <option value="Кондитерская">Кондитерская</option>
                <option value="Холодный цех">Холодный цех</option>
              </select>
            </div>
          </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {!retail && (
            <div>
              <label htmlFor="productedit-f5" className="label">Метод приготовления</label>
              <select id="productedit-f5" value={form.cookingMethod} onChange={(e) => setForm({ ...form, cookingMethod: e.target.value })} className="input">
                <option value="">Не указан</option>
                <option value="Итальянская кофемашина">Итальянская кофемашина</option>
                <option value="Френч-пресс">Френч-пресс</option>
                <option value="Варка">Варка</option>
                <option value="Жарка">Жарка</option>
                <option value="Запекание">Запекание</option>
                <option value="Гриль">Гриль</option>
                <option value="Пароварка">Пароварка</option>
                <option value="Сборка">Сборка</option>
              </select>
              <p className="text-[10px] text-gray-500 mt-1">Определяет приоритет печати на чеке (1, 2, 3...)</p>
            </div>
            )}
            <div className="flex items-end">
              <label className="flex items-center gap-3 pb-1">
                <input type="checkbox" checked={form.noDiscounts} onChange={(e) => setForm({ ...form, noDiscounts: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600" />
                <span className="text-sm font-medium text-gray-700">Не участвует в скидках</span>
              </label>
            </div>
          </div>
          {(
            <div className="card space-y-3 bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700">Единицы измерения</h3>
              <p className="text-xs text-gray-500">
                Укажите как товар закупается и продаётся. Для овощей, сыра, мяса на развес выберите продажу в килограммах:
                цена и остаток тогда считаются за 1 кг, а вес кассир вводит на кассе.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="productedit-f6" className="label text-xs">Закупка</label>
                  <select id="productedit-f6" value={form.purchaseUnit || ""} onChange={(e) => setForm({ ...form, purchaseUnit: e.target.value })} className="input text-sm">
                    <option value="">Штука</option>
                    <option value="кг">Кг</option>
                    <option value="л">Литр</option>
                    <option value="упаковка">Упаковка</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="productedit-f7" className="label text-xs">Продажа</label>
                  <select id="productedit-f7" value={form.saleUnit || ""} onChange={(e) => setForm({ ...form, saleUnit: e.target.value })} className="input text-sm">
                    <option value="">Штука</option>
                    <option value="кг">Килограмм (весовой товар)</option>
                    <option value="г">Грамм</option>
                    <option value="мл">Мл</option>
                    <option value="portion">Порция</option>
                  </select>
                </div>
                {form.purchaseUnit && form.saleUnit && form.purchaseUnit !== form.saleUnit && (
                  <div>
                    <label htmlFor="productedit-f8" className="label text-xs">Себестоимость закупки</label>
                    <input id="productedit-f8"
                      type="number"
                      step="0.01"
                      value={form.purchaseCost || ""}
                      onChange={(e) => {
                        const purchaseCost = parseFloat(e.target.value) || 0;
                        const factor = getConversionFactor(form.purchaseUnit, form.saleUnit);
                        setForm({
                          ...form,
                          purchaseCost,
                          costPrice: factor ? purchaseCost / factor : 0,
                        });
                      }}
                      className="input text-sm"
                      placeholder="Стоимость партии"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">Общая стоимость закупки</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Цены</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="productedit-f9" className="label">Цена продажи за {form.saleUnit || "шт"} *</label>
              <input id="productedit-f9" type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: parseFloat(e.target.value) || 0 })} className="input" required />
            </div>
            <div>
              <label htmlFor="productedit-f10" className="label">Себестоимость за {form.saleUnit || "шт"}</label>
              {form.purchaseUnit && form.saleUnit && form.purchaseUnit !== form.saleUnit ? (
                <input id="productedit-f10" type="text" readOnly value={`${money(form.costPrice)} (авто)`} className="input bg-gray-100 text-gray-600 cursor-not-allowed" />
              ) : (
                <input id="productedit-f10" type="number" step="0.01" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: parseFloat(e.target.value) || 0 })} className="input" />
              )}
              {lastSupply && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, costPrice: lastSupply.costPrice })}
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-info-100 bg-info-50 px-2 py-1 text-left text-xs text-info-700 hover:bg-info-100"
                  title="Подставить цену последней поставки"
                >
                  <History className="h-3.5 w-3.5 flex-shrink-0" />
                  Последняя поставка: {money(lastSupply.costPrice)} · {format(new Date(lastSupply.date), "d MMM", { locale: ru })}
                  {lastSupply.supplierName ? ` · ${lastSupply.supplierName}` : ""}
                </button>
              )}
            </div>
            <div>
              <label htmlFor="productedit-f11" className="label">Моржа за {form.saleUnit || "шт"}</label>
              <input id="productedit-f11" type="text" readOnly value={`${money(form.price - form.costPrice)} (${form.costPrice > 0 ? Math.round(((form.price - form.costPrice) / form.costPrice) * 100) : 0}%)`} className="input bg-gray-50 text-gray-700 cursor-not-allowed" />
            </div>
          </div>
          <div>
            <label htmlFor="productedit-f12" className="label">Налог (%)</label>
            <input id="productedit-f12" type="number" step="0.01" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: parseFloat(e.target.value) || 0 })} className="input w-32" />
          </div>
        </div>

        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Склад</h2>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={form.trackInventory} onChange={(e) => setForm({ ...form, trackInventory: e.target.checked })} className="h-4 w-4 rounded border-gray-300 text-primary-600" />
            <span className="text-sm font-medium text-gray-700">Учитывать остатки</span>
          </label>
          {form.trackInventory && (
            <div className="grid grid-cols-2 gap-4">
              <div><label htmlFor="productedit-f13" className="label">Текущий остаток{form.saleUnit === "кг" ? ", кг" : form.saleUnit === "г" ? ", г" : ""}</label><input id="productedit-f13" type="number" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: parseFloat(e.target.value) || 0 })} className="input" step="any" /></div>
              <div><label htmlFor="productedit-f14" className="label">Минимальный остаток{form.saleUnit === "кг" ? ", кг" : form.saleUnit === "г" ? ", г" : ""}</label><input id="productedit-f14" type="number" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: parseFloat(e.target.value) || 0 })} className="input" step="any" /></div>
            </div>
          )}
        </div>

        {/* Рецептуры — для кафе; в магазине раздела «Тех карты» нет. */}
        {!retail && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ChefHat className="h-5 w-5 text-warning-500" />
              <h2 className="text-lg font-semibold text-gray-900">Тех карта (рецептура)</h2>
            </div>
            <button
              type="button"
              onClick={() => navigate("/tech-cards?create=true")}
              className="flex items-center gap-1 rounded-lg bg-warning-50 px-3 py-1.5 text-sm font-medium text-warning-600 hover:bg-warning-100"
            >
              <Plus className="h-4 w-4" />
              Создать техкарту
            </button>
          </div>
          <p className="text-sm text-gray-500">Выберите техкарту для товара. При оплате заказа остатки ингредиентов спишутся автоматически.</p>

          <div>
            <label htmlFor="productedit-f15" className="label">Тех карта</label>
            <select id="productedit-f15"
              value={form.techCardId}
              onChange={(e) => setForm({ ...form, techCardId: e.target.value })}
              className="input"
            >
              <option value="">Без техкарты</option>
              {techCardsList.map((tc) => (
                <option key={tc.id} value={tc.id}>{tc.name}</option>
              ))}
            </select>
          </div>

          {form.techCardId && (() => {
            const selected = techCardsList.find((tc) => tc.id === form.techCardId);
            if (!selected) return null;
            let ingredients: TechCardItem[] = [];
            try { ingredients = JSON.parse(selected.ingredients || "[]"); } catch {}
            const markup = form.price > 0 && selected.totalCost > 0
              ? Math.round(((form.price - selected.totalCost) / selected.totalCost) * 100)
              : 0;

            return (
              <div className="rounded-lg bg-warning-50 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-warning-800">{selected.name}</p>
                  <button
                    type="button"
                    onClick={() => navigate(`/tech-cards`)}
                    className="flex items-center gap-1 text-xs text-warning-600 hover:text-warning-800"
                  >
                    Открыть <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500 text-xs">Ингредиентов</p>
                    <p className="font-semibold text-gray-900">{ingredients.length}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Себестоимость</p>
                    <p className="font-semibold text-gray-900">{selected.totalCost.toLocaleString("ru-RU")} СУМ</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Выход</p>
                    <p className="font-semibold text-gray-900">{selected.output} {selected.unit}</p>
                  </div>
                </div>
                {form.price > 0 && (
                  <div className="pt-2 border-t border-warning-200 flex justify-between text-xs">
                    <span className="text-gray-600">Цена: <span className="font-semibold text-gray-900">{form.price.toLocaleString("ru-RU")} СУМ</span></span>
                    <span className="text-gray-600">Маржа: <span className="font-semibold text-success-600">{(form.price - selected.totalCost).toLocaleString("ru-RU")} СУМ ({markup}%)</span></span>
                  </div>
                )}
              </div>
            );
          })()}

          {!form.techCardId && (
            <div className="rounded-lg border-2 border-dashed border-gray-200 p-6 text-center">
              <ChefHat className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-2 text-sm text-gray-500">Тех карта не выбрана</p>
              <p className="text-xs text-gray-500">Выберите техкарту или создайте новую</p>
            </div>
          )}
        </div>
        )}

        <div className="card space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Идентификация</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="productedit-f16" className="label">{form.saleUnit === "кг" ? "Код на весах (PLU)" : "Артикул / короткий код"}</label>
              <input id="productedit-f16" type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className="input" placeholder={form.saleUnit === "кг" ? "например, 104" : "Артикул товара"} />
              <p className="mt-1 text-xs text-gray-500">Его можно набрать на кассе цифрами, если штрихкода нет.</p>
            </div>
            {!retail && (
            <div>
              <label htmlFor="productedit-f17" className="label">Штрихкод</label>
              <input id="productedit-f17" type="text" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="input" placeholder="Штрихкод" />
              {ikpu && (
                <p className="mt-1 text-xs text-gray-500">
                  ИКПУ (национальный каталог): <span className="font-mono text-gray-700">{ikpu}</span>
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">Кассир сканирует его — товар сразу попадает в чек.</p>
            </div>
            )}
          </div>
          <Checkbox
            label="Быстрая кнопка на кассе"
            description="Для товаров без штрихкода — хлеб, пакет: одно касание на экране кассы магазина."
            checked={form.quick}
            onChange={(e) => setForm({ ...form, quick: e.target.checked })}
          />
          <div><label htmlFor="productedit-f18" className="label">URL изображения</label><input id="productedit-f18" type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} className="input" placeholder="https://..." /></div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={() => navigate("/products")} className="btn-secondary">Отмена</button>
          <button type="submit" disabled={isPending} className="btn-primary">
            {isPending ? "Сохранение..." : <><Save className="mr-2 h-4 w-4" />{isNew ? "Создать товар" : "Сохранить"}</>}
          </button>
        </div>
      </form>
      {scanning && (
        <BarcodeCamera
          onClose={() => setScanning(false)}
          onDetected={(code) => {
            setScanning(false);
            void applyBarcode(code);
          }}
        />
      )}
    </div>
  );
}
