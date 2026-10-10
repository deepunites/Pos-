import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { X, Plus, Trash2, PackagePlus, Loader2, ScanBarcode, History } from "lucide-react";
import { useDebounced } from "../hooks/useDebounced";
import api from "../services/api";
import toast from "react-hot-toast";
import type { Category, Product } from "../types";
import { useMoney } from "../hooks/useMoney";
import { weightUnitOf } from "../utils/weight";
import { apiErrorMessage } from "../utils/apiError";
import { useHoldAppUpdate } from "../services/appUpdate";

interface StockReceiptScreenProps {
  onClose: () => void;
}

interface StagedItem {
  key: string;
  quantity: number;
  costPrice: number;
  salePrice: number;
  // A brand-new product is always priced; an existing one only when the
  // operator typed a new price.
  isNewProduct: boolean;
  label: string;
  categoryLabel: string;
  payload:
    | { productId: string }
    | { newProduct: { name: string; categoryId?: string; newCategoryName?: string; unit: string; barcode?: string } };
}


// Остаток для подписи в списке: округлён до грамма и с единицей у весового
// товара — без этого «82.96000000000001» и непонятно, штуки это или килограммы.
function stockText(p: Pick<Product, "currentStock" | "saleUnit">): string {
  const value = Math.round(Number(p.currentStock) * 1000) / 1000;
  const unit = weightUnitOf(p.saleUnit);
  const text = String(value).replace(".", ",");
  return unit ? `${text} ${unit}` : text;
}

function computeSalePrice(costPrice: number, markupPercent: number): number {
  const price = costPrice * (1 + markupPercent / 100);
  return Math.round(price * 100) / 100;
}

export default function StockReceiptScreen({ onClose }: StockReceiptScreenProps) {
  useHoldAppUpdate();
  const { money } = useMoney();
  const qc = useQueryClient();

  const [supplierName, setSupplierName] = useState("");
  const [items, setItems] = useState<StagedItem[]>([]);

  const [categoryMode, setCategoryMode] = useState<"existing" | "new">("existing");
  const [categoryId, setCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");

  const [productMode, setProductMode] = useState<"existing" | "new">("existing");
  const [productId, setProductId] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [unit, setUnit] = useState("шт");

  const [quantity, setQuantity] = useState("1");
  const [costPrice, setCostPrice] = useState("");
  // Empty means "leave the shelf price as it is". It is prefilled from the
  // category markup when there is one, so the common case stays one tap.
  const [salePrice, setSalePrice] = useState("");
  const [salePriceTouched, setSalePriceTouched] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["settings-markup"],
    queryFn: () => api.get("/settings").then((r) => r.data.data),
  });
  const defaultMarkup = Number(settings?.defaultMarkupPercent) || 0;
  // Магазин: товар ищут сканером или по названию, категорий нет.
  const retail = settings?.businessType === "retail";
  const [pickQuery, setPickQuery] = useState("");
  const [picked, setPicked] = useState<Product | null>(null);
  const [newBarcode, setNewBarcode] = useState<string | undefined>();
  const [looking, setLooking] = useState(false);
  const pickSearch = useDebounced(pickQuery.trim(), 250);
  const { data: pickSuggestions = [] } = useQuery<Product[]>({
    queryKey: ["receipt-search", pickSearch],
    queryFn: () => api.get("/products", { params: { search: pickSearch, limit: 8, isIngredient: false } }).then((r) => r.data.data as Product[]),
    enabled: retail && !picked && productMode === "existing" && pickSearch.length >= 2 && !/^\d+$/.test(pickSearch),
  });
  const { data: lastSupply } = useQuery<{ costPrice: number; date: string } | null>({
    queryKey: ["last-supply", picked?.id],
    queryFn: () => api.get("/products/last-supply", { params: { ids: picked!.id } }).then((r) => r.data.data[picked!.id] ?? null),
    enabled: retail && !!picked,
  });

  // Штрихкод со сканера (цифры + Enter): свой товар — выбрать, незнакомый —
  // новый товар с названием из базы штрихкодов.
  const pickBarcode = async (code: string) => {
    setLooking(true);
    try {
      const own = await api
        .get("/products/lookup", { params: { code } })
        .then((r) => r.data.data as Product)
        .catch((error) => {
          if (error?.response?.status === 404) return null;
          throw error;
        });
      if (own) {
        setPicked(own);
        setProductMode("existing");
      } else {
        const answer = await api.post("/catalog/lookup", { code }).then((r) => r.data.data as { found: boolean; displayName?: string });
        setProductMode("new");
        setNewProductName(answer.found ? answer.displayName ?? "" : "");
        setNewBarcode(code);
        if (!answer.found) toast("Штрихкода нет в базе — введите название", { duration: 3000 });
      }
      setPickQuery("");
    } catch {
      toast.error("Не удалось проверить штрихкод — проверьте соединение");
    } finally {
      setLooking(false);
    }
  };

  const { data: categories } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => api.get("/categories").then((r) => r.data.data),
  });

  const { data: categoryProducts } = useQuery<Product[]>({
    queryKey: ["products-for-receipt", categoryId],
    queryFn: () =>
      api
        .get("/products", { params: { categoryId, limit: 200, isActive: undefined } })
        .then((r) => r.data.data as Product[]),
    enabled: categoryMode === "existing" && !!categoryId,
  });

  const selectedCategory = categories?.find((c) => c.id === categoryId);
  const effectiveMarkup = !retail && categoryMode === "existing" && selectedCategory ? Number(selectedCategory.markupPercent) || 0 : defaultMarkup;

  const selectedProduct = retail ? picked ?? undefined : categoryProducts?.find((p) => p.id === productId);

  // A markup of 0% is not a markup: deriving a price from it would set the
  // shelf price to the purchase price. In that case the current price is
  // suggested instead (and a new product simply asks for one).
  const suggestedPrice = useMemo(() => {
    const cost = parseFloat(costPrice);
    if (effectiveMarkup > 0 && cost > 0) return computeSalePrice(cost, effectiveMarkup);
    if (productMode === "existing" && selectedProduct) return Number(selectedProduct.price) || 0;
    return 0;
  }, [costPrice, effectiveMarkup, productMode, selectedProduct]);

  // Пока кассир не трогал цену продажи, поле следует за подсказкой (наценка
  // от себестоимости). Поле при этом редактируемое, поэтому значение живёт в
  // состоянии, а не вычисляется.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- поле следует за подсказкой, пока его не правили
    if (!salePriceTouched) setSalePrice(suggestedPrice > 0 ? String(suggestedPrice) : "");
  }, [suggestedPrice, salePriceTouched]);

  const parsedSalePrice = salePrice === "" ? null : parseFloat(salePrice);
  const parsedCost = parseFloat(costPrice) || 0;
  const margin = parsedSalePrice !== null && parsedCost > 0 ? parsedSalePrice - parsedCost : null;

  const canAdd =
    (retail || (categoryMode === "existing" ? !!categoryId : newCategoryName.trim().length > 0)) &&
    (productMode === "existing" ? (retail ? !!picked : !!productId) : newProductName.trim().length > 0) &&
    parseFloat(quantity) > 0 &&
    parseFloat(costPrice) >= 0 &&
    costPrice !== "" &&
    (productMode === "existing" || (parsedSalePrice !== null && parsedSalePrice > 0));

  const resetProductFields = (): void => {
    setPicked(null);
    setPickQuery("");
    setNewBarcode(undefined);
    setProductId("");
    setNewProductName("");
    setQuantity("1");
    setCostPrice("");
    setSalePrice("");
    setSalePriceTouched(false);
  };

  const handleCategoryModeChange = (mode: "existing" | "new"): void => {
    setCategoryMode(mode);
    setCategoryId("");
    setNewCategoryName("");
    setProductMode(mode === "new" ? "new" : "existing");
    resetProductFields();
  };

  const handleAddItem = (): void => {
    if (!canAdd) return;
    const qty = parseFloat(quantity);
    const cost = parseFloat(costPrice);
    const currentPrice = Number(selectedProduct?.price) || 0;
    const chosen = parsedSalePrice ?? 0;
    // Sending back the price the product already has would be a no-op write;
    // 0 marks "leave it alone".
    const sale = productMode === "existing" && chosen === currentPrice ? 0 : chosen;

    let payload: StagedItem["payload"];
    let label: string;
    let categoryLabel: string;

    if (retail && productMode === "existing" && picked) {
      payload = { productId: picked.id };
      label = picked.name;
      categoryLabel = picked.barcode ?? "";
    } else if (retail) {
      payload = { newProduct: { name: newProductName.trim(), unit, barcode: newBarcode } };
      label = `${newProductName.trim()} (новый)`;
      categoryLabel = newBarcode ?? "";
    } else if (productMode === "existing") {
      const product = categoryProducts?.find((p) => p.id === productId);
      payload = { productId };
      label = product?.name || "Товар";
      categoryLabel = selectedCategory?.name || "";
    } else {
      payload = {
        newProduct: {
          name: newProductName.trim(),
          unit,
          ...(categoryMode === "existing" ? { categoryId } : { newCategoryName: newCategoryName.trim() }),
        },
      };
      label = `${newProductName.trim()} (новый)`;
      categoryLabel = categoryMode === "existing" ? selectedCategory?.name || "" : `${newCategoryName.trim()} (новая)`;
    }

    setItems((prev) => [
      ...prev,
      {
        key: `${Date.now()}-${Math.random()}`,
        quantity: qty,
        costPrice: cost,
        // 0 means "leave the shelf price alone" — only a price the operator
        // actually chose is sent to the backend.
        salePrice: sale,
        isNewProduct: productMode !== "existing",
        label,
        categoryLabel,
        payload,
      },
    ]);
    resetProductFields();
  };

  const handleRemoveItem = (key: string): void => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const total = items.reduce((sum, i) => sum + i.quantity * i.costPrice, 0);

  const createMutation = useMutation({
    mutationFn: () =>
      api.post("/stock-receipts", {
        supplierName: supplierName || undefined,
        items: items.map((i) => ({
          ...i.payload,
          quantity: i.quantity,
          costPrice: i.costPrice,
          salePrice: i.salePrice > 0 ? i.salePrice : undefined,
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["products-all"] });
      qc.invalidateQueries({ queryKey: ["products-for-receipt"] });
      toast.success("Приход оформлен");
      onClose();
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, "Не удалось оформить приход"));
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" style={{ animation: "fade-in 0.2s ease" }}>
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-md border border-dark-600 bg-dark-800 shadow-2xl"
        style={{ animation: "scale-in 0.2s ease" }}
      >
        <div className="flex items-center justify-between border-b border-dark-700 px-6 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary-400" />
            <h3 className="text-lg font-bold text-dark-50">Приход товара</h3>
          </div>
          <button onClick={onClose} className="rounded p-2 text-dark-400 hover:bg-dark-700 hover:text-dark-50 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <div>
            <label htmlFor="stockreceipt-f1" className="mb-1 block text-xs font-medium text-dark-400">Поставщик (необязательно)</label>
            <input id="stockreceipt-f1"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              placeholder="Название поставщика"
              className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
            />
          </div>

          <div className="rounded border border-dark-700 bg-dark-900/50 p-4 space-y-4">
            {retail ? (
              <div>
                <p className="mb-1.5 block text-xs font-medium text-dark-400">Товар</p>
                {productMode === "existing" && picked ? (
                  <div className="flex items-center gap-3 rounded border-2 border-primary-500 bg-dark-700 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-dark-50">{picked.name}</p>
                      <p className="text-[11px] text-dark-400">
                        остаток {stockText(picked)}
                        {picked.barcode ? ` · ${picked.barcode}` : ""}
                      </p>
                    </div>
                    <button onClick={resetProductFields} className="rounded p-1 text-dark-400 hover:text-dark-50" aria-label="Другой товар">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : productMode === "new" ? (
                  <div className="space-y-1.5">
                    <div className="flex gap-2">
                      <input
                        value={newProductName}
                        onChange={(e) => setNewProductName(e.target.value)}
                        placeholder="Название нового товара"
                        className="flex-1 rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                      />
                      <select
                        value={unit === "кг" ? "кг" : "шт"}
                        onChange={(e) => setUnit(e.target.value)}
                        aria-label="Как продаётся"
                        className="w-28 rounded border-2 border-dark-600 bg-dark-700 px-2 py-2 text-sm text-dark-50 focus:border-primary-500 focus:outline-none"
                      >
                        <option value="шт">шт</option>
                        <option value="кг">на вес, кг</option>
                      </select>
                    </div>
                    <p className="text-[11px] text-dark-400">
                      <span className="rounded bg-warning-500/15 px-1.5 font-semibold text-warning-400">новый</span>
                      {newBarcode ? ` штрихкод ${newBarcode} · ` : " "}
                      без категории — у магазина товар ищут сканером.{" "}
                      <button onClick={() => { setProductMode("existing"); resetProductFields(); }} className="underline hover:text-dark-50">
                        Отмена
                      </button>
                    </p>
                  </div>
                ) : (
                  <div className="relative">
                    <ScanBarcode className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-400" />
                    <input
                      value={pickQuery}
                      onChange={(e) => setPickQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && /^\d{6,}$/.test(pickQuery.trim())) {
                          e.preventDefault();
                          void pickBarcode(pickQuery.trim());
                        }
                      }}
                      placeholder="Сканируйте штрихкод или введите название"
                      className="w-full rounded border-2 border-dark-600 bg-dark-700 py-2 pl-9 pr-3 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                    />
                    {looking && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-dark-400" />}
                    {pickSuggestions.length > 0 && (
                      <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded border border-dark-600 bg-dark-800 shadow-lg">
                        {pickSuggestions.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => {
                              setPicked(p);
                              setPickQuery("");
                            }}
                            className="flex w-full justify-between px-3 py-2 text-left text-sm text-dark-50 hover:bg-dark-700"
                          >
                            <span className="truncate">{p.name}</span>
                            <span className="text-xs text-dark-400">остаток {stockText(p)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setProductMode("new");
                        setNewProductName(/^\d+$/.test(pickQuery.trim()) ? "" : pickQuery.trim());
                        setPickQuery("");
                      }}
                      className="mt-1.5 text-xs font-medium text-primary-400 hover:text-primary-300"
                    >
                      + Новый товар
                    </button>
                  </div>
                )}
              </div>
            ) : (
            <>
            {/* Category */}
            <div>
              <p id="receipt-category" className="mb-1.5 block text-xs font-medium text-dark-400">Категория</p>
              <div className="mb-2 flex gap-1.5">
                <button
                  onClick={() => handleCategoryModeChange("existing")}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    categoryMode === "existing" ? "bg-primary-600 text-white" : "bg-dark-700 text-dark-400 hover:text-white"
                  }`}
                >
                  Существующая
                </button>
                <button
                  onClick={() => handleCategoryModeChange("new")}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    categoryMode === "new" ? "bg-primary-600 text-white" : "bg-dark-700 text-dark-400 hover:text-white"
                  }`}
                >
                  + Новая категория
                </button>
              </div>
              {categoryMode === "existing" ? (
                <select
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value);
                    setProductMode("existing");
                    resetProductFields();
                  }}
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 focus:border-primary-500 focus:outline-none"
                >
                  <option value="">Выберите категорию</option>
                  {categories?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} (наценка {Number(c.markupPercent) || 0}%)
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="Название новой категории"
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                />
              )}
              {categoryMode === "new" && (
                <p className="mt-1.5 text-[11px] text-dark-500">
                  Наценка по умолчанию {defaultMarkup}% (задаётся администратором в настройках). Изменить наценку для этой категории можно в админ-панели.
                </p>
              )}
            </div>

            {/* Product */}
            <div>
              <p id="receipt-product" className="mb-1.5 block text-xs font-medium text-dark-400">Товар</p>
              {categoryMode === "existing" && categoryId && (
                <div className="mb-2 flex gap-1.5">
                  <button
                    onClick={() => {
                      setProductMode("existing");
                      resetProductFields();
                    }}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      productMode === "existing" ? "bg-primary-600 text-white" : "bg-dark-700 text-dark-400 hover:text-white"
                    }`}
                  >
                    Существующий
                  </button>
                  <button
                    onClick={() => {
                      setProductMode("new");
                      resetProductFields();
                    }}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      productMode === "new" ? "bg-primary-600 text-white" : "bg-dark-700 text-dark-400 hover:text-white"
                    }`}
                  >
                    + Новый товар
                  </button>
                </div>
              )}

              {productMode === "existing" ? (
                <select
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  disabled={!categoryId}
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 focus:border-primary-500 focus:outline-none disabled:opacity-40"
                >
                  <option value="">{categoryId ? "Выберите товар" : "Сначала выберите категорию"}</option>
                  {categoryProducts?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (остаток {stockText(p)})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={newProductName}
                    onChange={(e) => setNewProductName(e.target.value)}
                    placeholder="Название товара"
                    className="flex-1 rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                  />
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    placeholder="ед."
                    className="w-20 rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                  />
                </div>
              )}
            </div>

            </>
            )}

            {/* Quantity + cost price */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="stockreceipt-f2" className="mb-1.5 block text-xs font-medium text-dark-400">Количество</label>
                <input id="stockreceipt-f2"
                  type="number"
                  min="0"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 focus:border-primary-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="stockreceipt-f3" className="mb-1.5 block text-xs font-medium text-dark-400">Цена прихода (за ед.)</label>
                <input id="stockreceipt-f3"
                  type="number"
                  min="0"
                  step="0.01"
                  value={costPrice}
                  onChange={(e) => setCostPrice(e.target.value)}
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 px-3 py-2 text-sm text-dark-50 focus:border-primary-500 focus:outline-none"
                />
                {lastSupply && (
                  <button
                    onClick={() => setCostPrice(String(lastSupply.costPrice))}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary-400 hover:text-primary-300"
                    title="Подставить цену последней поставки"
                  >
                    <History className="h-3 w-3" />
                    посл.: {money(lastSupply.costPrice)} · {new Date(lastSupply.date).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded bg-dark-800 px-4 py-3">
              <label htmlFor="stockreceipt-f4" className="block text-xs text-dark-400">
                Цена продажи
                {effectiveMarkup > 0 ? ` (наценка ${effectiveMarkup}%)` : retail ? "" : " — наценка категории не задана"}
              </label>
              <input id="stockreceipt-f4"
                type="number"
                inputMode="decimal"
                value={salePrice}
                onChange={(e) => {
                  setSalePriceTouched(true);
                  setSalePrice(e.target.value);
                }}
                placeholder={productMode === "existing" ? "без изменений" : "укажите цену"}
                className="w-full rounded border border-dark-600 bg-dark-700 px-3 py-2 text-lg font-bold text-primary-400 focus:border-primary-500 focus:outline-none"
              />
              {margin !== null && (
                <p className={`text-[11px] ${margin > 0 ? "text-success-500" : "text-danger-500"}`}>
                  Маржа {money(margin)}
                  {parsedCost > 0 ? ` (${Math.round((margin / parsedCost) * 100)}%)` : ""}
                  {margin <= 0 ? " — продажа не выше себестоимости" : ""}
                </p>
              )}
            </div>

            <button
              onClick={handleAddItem}
              disabled={!canAdd}
              className="flex w-full items-center justify-center gap-2 rounded bg-dark-700 py-2.5 text-sm font-semibold text-dark-50 transition-colors hover:bg-dark-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              Добавить в приход
            </button>
          </div>

          {/* Staged items list */}
          {items.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-dark-500">Позиции прихода ({items.length})</h4>
              {items.map((item) => (
                <div key={item.key} className="flex items-center gap-3 rounded border border-dark-700 bg-dark-900/50 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-dark-50">{item.label}</p>
                    <p className="text-[11px] text-dark-500">
                      {item.categoryLabel} · {item.quantity} × {money(item.costPrice)}
                      {item.salePrice > 0 ? ` → продажа ${money(item.salePrice)}` : " · цена продажи без изменений"}
                    </p>
                  </div>
                  <span className="text-sm font-bold text-dark-50">{money(item.quantity * item.costPrice)}</span>
                  <button onClick={() => handleRemoveItem(item.key)} className="text-dark-500 hover:text-danger-500 transition-colors">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-dark-700 px-6 py-4 shrink-0 bg-dark-800/80">
          <div>
            <p className="text-xs text-dark-400">Итого по приходу</p>
            <p className="text-xl font-bold text-dark-50">{money(total)}</p>
          </div>
          <button
            onClick={() => createMutation.mutate()}
            disabled={items.length === 0 || createMutation.isPending}
            className="flex items-center gap-2 rounded bg-primary-600 px-6 py-3 text-sm font-bold text-white transition-all hover:bg-primary-500 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Оформить приход
          </button>
        </div>
      </div>
    </div>
  );
}
