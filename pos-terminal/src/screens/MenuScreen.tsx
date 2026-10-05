import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Minus,
  Trash2,
  ShoppingCart,
  LogOut,
  User,
  UtensilsCrossed,
  Package,
  X,
  Banknote,
  Hash,
  Phone,
  AlertCircle,
  Lock,
  PackagePlus,
  Sun,
  Moon,
} from "lucide-react";
import api from "../services/api";
import { ConnectionDot } from "../components/ConnectionStatus";
import { undoToast } from "../utils/undoToast";
import { useCartStore } from "../store/cartStore";
import { useThemeStore } from "../store/themeStore";
import toast from "react-hot-toast";
import { useMoney } from "../hooks/useMoney";
import { apiErrorMessage } from "../utils/apiError";
import type { Category, Product, CashShift, Table } from "../types";
import StockReceiptScreen from "./StockReceiptScreen";
import { usePermissions, type Permissions } from "../services/permissions";
import { UZ_PREFIX, formatLocal, fullPhone, localDigits } from "../utils/phone";

interface MenuScreenProps {
  user: { firstName: string; lastName: string; email: string; role: string; permissions?: Partial<Permissions> };
  shift: CashShift;
  onLogout: () => void;
  onCheckout: () => void;
  onCloseShift: () => void;
}


// Кнопки строки состояния — как .sh-chip у «Магазина» (screens/shop/shop.css).
const BAR_CHIP =
  "flex h-9 items-center gap-1.5 whitespace-nowrap rounded border border-white/15 px-3 text-sm font-medium transition-colors hover:border-white/40";
const BAR_ICON =
  "flex h-9 w-9 items-center justify-center rounded text-bar-muted transition-colors hover:bg-white/10 hover:text-white";


function useCurrentTime() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);
  return time;
}

function groupProductsByName(products: Product[]): Product[][] {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const key = p.name.toLowerCase().trim();
    const existing = groups.get(key) || [];
    existing.push(p);
    groups.set(key, existing);
  }
  return Array.from(groups.values());
}

// Синтетическая плитка «Без категории».
const UNCATEGORIZED = "__none__";

export default function MenuScreen({ user, onLogout, onCheckout, onCloseShift }: MenuScreenProps) {
  const { money, parts } = useMoney();
  const rights = usePermissions(user.permissions);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [showCustomerInput, setShowCustomerInput] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [volumePickerProduct, setVolumePickerProduct] = useState<Product[] | null>(null);
  const [portionPickerProduct, setPortionPickerProduct] = useState<Product | null>(null);
  const [showStockReceipt, setShowStockReceipt] = useState(false);
  const { theme, toggleTheme } = useThemeStore();
  const time = useCurrentTime();

  const portionOptions = [5, 10, 50, 100];

  const {
    items,
    tableId,
    addItem,
    removeItem,
    insertItem,
    updateQuantity,
    clearCart,
    restoreCart,
    getTotal,
    getItemCount,
    orderType,
    setOrderType,
    setTable,
    setCustomer,
  } = useCartStore();

  const { data: categoriesAll, isLoading: isLoadingCat, error: catError } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => api.get("/categories").then((r) => r.data.data),
  });
  const categories = useMemo(() => categoriesAll?.filter((c) => !c.isIngredient) ?? [], [categoriesAll]);

  // Real tables from the backend — the order needs the table's id, not a
  // number typed by hand.
  const { data: tables = [] } = useQuery<Table[]>({
    queryKey: ["tables"],
    queryFn: () =>
      api.get("/tables").then((r) =>
        // Numeric table numbers in natural order (1, 2, …, 10), others alphabetically.
        (r.data.data as Table[]).slice().sort((a, b) =>
          a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: "base" })
        )
      ),
    enabled: orderType === "dine_in" || !!tableId,
  });
  const selectedTable = tables.find((t) => t.id === tableId);
  const tableNumber = selectedTable?.number ?? "";

  const { data: allProductsData, isLoading: isLoadingProd, error: prodError } = useQuery<{ data: Product[] }>({
    queryKey: ["products-all", search],
    queryFn: () =>
      api.get("/products", {
        params: { search: search || undefined, limit: 200, isActive: true, isIngredient: false },
      }).then((r) => r.data),
  });

  const allProducts: Product[] = useMemo(() => allProductsData?.data || [], [allProductsData]);

  // Категории — ряд клавиш над меню; открыта всегда одна, по умолчанию первая.
  // Товары без категории — на своей вкладке, иначе их нашёл бы только поиск.
  const tabs = useMemo(() => {
    const list = categories.map((c) => ({ id: c.id, name: c.name, count: allProducts.filter((p) => p.categoryId === c.id).length }));
    const loose = allProducts.filter((p) => !p.categoryId).length;
    if (loose > 0) list.push({ id: UNCATEGORIZED, name: "Без категории", count: loose });
    return list;
  }, [categories, allProducts]);
  const activeCategory = tabs.some((t) => t.id === selectedCategory) ? selectedCategory : tabs[0]?.id ?? "";

  // Поиск — по всему меню, а не внутри открытой вкладки (сервер уже отфильтровал).
  const filteredProducts: Product[] = useMemo(() => {
    if (search) return allProducts;
    if (!activeCategory) return [];
    return allProducts.filter((p) => (activeCategory === UNCATEGORIZED ? !p.categoryId : p.categoryId === activeCategory));
  }, [allProducts, search, activeCategory]);

  const groupedProducts = useMemo(() => groupProductsByName(filteredProducts), [filteredProducts]);

  // Stock already committed to the cart counts as taken: the backend will
  // refuse the sale anyway, so the terminal refuses it up front instead of
  // letting the cashier ring up an item that cannot be paid for.
  const availableStock = (product: Product): number => {
    if (!product.trackInventory) return Number.POSITIVE_INFINITY;
    const inCart = items
      .filter((i) => i.productId === product.id)
      .reduce((sum, i) => sum + (i.grams ? i.grams : i.quantity), 0);
    return Number(product.currentStock) - inCart;
  };

  const handleProductClick = (variants: Product[], _event: React.MouseEvent): void => {
    if (variants.length === 1) {
      const product = variants[0];
      const saleUnit = product.saleUnit;
      if (saleUnit === "г") {
        if (availableStock(product) <= 0) {
          toast.error(`«${product.name}» нет в наличии`, { duration: 1500 });
          return;
        }
        setPortionPickerProduct(product);
        return;
      }
      handleAddProduct(product);
    } else {
      setVolumePickerProduct(variants);
    }
  };

  const handlePortionSelect = (product: Product, grams: number): void => {
    if (grams > availableStock(product)) {
      toast.error(`«${product.name}»: осталось ${Number(product.currentStock)} г`, { duration: 2000 });
      return;
    }
    const pricePerGram = Number(product.price);
    const portionPrice = pricePerGram * grams;
    const volumeLabel = product.volume ? ` (${product.volume})` : "";

    addItem({
      productId: product.id,
      name: product.name + volumeLabel + ` (${grams} г)`,
      price: portionPrice,
      quantity: 1,
      grams,
    });
    toast.success(`${product.name} (${grams} г) добавлен`, { duration: 1000 });
    setPortionPickerProduct(null);
  };

  const handleAddProduct = (product: Product): void => {
    if (availableStock(product) <= 0) {
      toast.error(`«${product.name}» нет в наличии`, { duration: 1500 });
      return;
    }
    const volumeLabel = product.volume ? ` (${product.volume})` : "";
    const pricePerUnit = Number(product.price);

    addItem({
      productId: product.id,
      name: product.name + volumeLabel,
      price: pricePerUnit,
      quantity: 1,
    });
    toast.success(`${product.name}${volumeLabel} добавлен`, { duration: 1000 });
  };

  const handleSelectVolume = (product: Product): void => {
    handleAddProduct(product);
    setVolumePickerProduct(null);
  };

  const getQtyInCart = (productId: string): number => {
    const item = items.find((i) => i.productId === productId || i.productId.startsWith(productId));
    return item?.quantity || 0;
  };

  const getTotalQtyForGroup = (variants: Product[]): number => {
    return variants.reduce((sum, v) => sum + getQtyInCart(v.id), 0);
  };

  const handleTableSelect = (table: Table | null) => {
    setTable(table?.id);
    setShowTablePicker(false);
    toast.success(table ? `Стол №${table.number} выбран` : "Заказ без стола");
  };

  const handleSaveCustomer = () => {
    const phone = fullPhone(customerPhone);
    if (phone === null) {
      toast.error("Допишите номер: после +998 нужно 9 цифр");
      return;
    }
    setCustomer(customerName || undefined, phone);
    setShowCustomerInput(false);
    if (customerName) toast.success(`Клиент: ${customerName}`);
  };

  const isLoading = isLoadingCat || isLoadingProd;
  const hasError = catError || prodError;

  // F8 — оплата, F3 — поиск, как в «Магазине». Пока открыто окно — не перехватываем.
  const searchRef = useRef<HTMLInputElement>(null);
  const anyModal = showTablePicker || showCustomerInput || !!volumePickerProduct || !!portionPickerProduct || showStockReceipt;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyModal) return;
      if (e.key === "F8" && useCartStore.getState().items.length > 0) {
        e.preventDefault();
        onCheckout();
      } else if (e.key === "F3") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyModal, onCheckout]);

  const total = parts(getTotal());

  // Удаление и очистка — без подтверждения, но с «Вернуть» на 5 секунд (D-7).
  const removeLine = useCallback(
    (id: string) => {
      const list = useCartStore.getState().items;
      const index = list.findIndex((i) => i.id === id);
      if (index < 0) return;
      const line = list[index];
      removeItem(id);
      undoToast(`«${line.name}» убрана`, () => insertItem(line, index));
    },
    [insertItem, removeItem]
  );

  const clearOrder = useCallback(() => {
    const { items: lines, tableId: table, customerName: name, customerPhone: phone } = useCartStore.getState();
    if (lines.length === 0) return;
    clearCart();
    undoToast(`Заказ очищен · ${lines.length} поз.`, () => restoreCart({ items: lines, tableId: table, customerName: name, customerPhone: phone }));
  }, [clearCart, restoreCart]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-dark-950">
      {/* ═══ Строка состояния — графит в обеих темах, как у «Магазина» ═══ */}
      <header className="flex h-[52px] shrink-0 items-center gap-2 bg-bar px-4 text-bar-fg">
        <span className="mr-2 text-xl font-semibold leading-none text-white">Qwik</span>

        <div className="flex h-9 overflow-hidden rounded border border-white/15">
          {([
            { key: "dine_in" as const, label: "В зале", icon: UtensilsCrossed },
            { key: "takeaway" as const, label: "Навынос", icon: Package },
          ]).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setOrderType(key)}
              aria-pressed={orderType === key}
              className={`flex items-center gap-1.5 px-3 text-sm font-medium transition-colors ${
                orderType === key ? "bg-key text-white" : "text-bar-muted hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="whitespace-nowrap">{label}</span>
            </button>
          ))}
        </div>

        {orderType === "dine_in" && (
          <button onClick={() => setShowTablePicker(true)} className={BAR_CHIP}>
            <Hash className="h-4 w-4 text-bar-muted" />
            {tableNumber ? `Стол ${tableNumber}` : "Выбрать стол"}
          </button>
        )}

        <button onClick={() => setShowCustomerInput(true)} className={BAR_CHIP}>
          <User className="h-4 w-4 text-bar-muted" />
          <span className="max-w-[9rem] truncate">{customerName || "Клиент"}</span>
        </button>

        <div className="flex-1" />

        {rights.canReceiveStock && (
          <button onClick={() => setShowStockReceipt(true)} className={BAR_CHIP} title="Оформить приход товара">
            <PackagePlus className="h-4 w-4 text-bar-muted" />
            Приход
          </button>
        )}
        <span className="h-6 w-px bg-white/15" />
        <button onClick={onCloseShift} className={BAR_CHIP} title="Закрыть смену">
          <span className="h-2 w-2 rounded-full bg-success-500" />
          Смена
          <Lock className="h-4 w-4 text-bar-muted" />
        </button>
        <ConnectionDot />
        <span className="text-sm tabular-nums text-bar-muted">
          {time.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <button
          onClick={toggleTheme}
          className={BAR_ICON}
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <span className="flex items-center gap-2 whitespace-nowrap text-sm font-medium">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-key text-xs font-semibold text-white">
            {`${user.firstName[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase()}
          </span>
          <span className="hidden xl:inline">{user.firstName}</span>
        </span>
        <button onClick={onLogout} className={BAR_ICON} aria-label="Выйти" title="Выйти">
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {/* ═══ Table Picker Modal ═══ */}
      {showTablePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-md border border-dark-600 bg-dark-800 p-6 w-96 shadow-2xl" style={{ animation: "scale-in 0.2s ease" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-dark-50">Выберите стол</h3>
              <button onClick={() => setShowTablePicker(false)} className="rounded p-1 text-dark-400 hover:text-dark-50">
                <X className="h-5 w-5" />
              </button>
            </div>
            {tables.length === 0 ? (
              <p className="py-6 text-center text-sm text-dark-400">Столы не заведены — добавьте их в панели управления</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 max-h-80 overflow-y-auto">
                {tables.map((table) => {
                  const busy = table.status === "occupied" || (table.orders?.length ?? 0) > 0;
                  return (
                    <button
                      key={table.id}
                      onClick={() => handleTableSelect(table)}
                      title={table.zone || undefined}
                      className={`relative flex h-14 flex-col items-center justify-center rounded border-2 text-sm font-bold transition-all active:scale-95 ${
                        tableId === table.id
                          ? "border-primary-500 bg-primary-600/20 text-primary-400"
                          : busy
                          ? "border-warning-500/40 bg-warning-500/10 text-warning-500"
                          : "border-dark-600 bg-dark-700 text-dark-300 hover:border-dark-400 hover:text-dark-50"
                      }`}
                    >
                      {table.number}
                      {busy && <span className="text-[9px] font-medium">занят</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {tableId && (
              <button
                onClick={() => handleTableSelect(null)}
                className="mt-3 w-full rounded border border-dark-600 bg-dark-700 py-2 text-xs font-medium text-dark-300 hover:text-dark-50"
              >
                Убрать стол
              </button>
            )}
          </div>
        </div>
      )}

      {/* ═══ Customer Input Modal ═══ */}
      {showCustomerInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-md border border-dark-600 bg-dark-800 p-6 w-96 shadow-2xl" style={{ animation: "scale-in 0.2s ease" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-dark-50">Информация о клиенте</h3>
              <button onClick={() => setShowCustomerInput(false)} className="rounded p-1 text-dark-400 hover:text-dark-50">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-400" />
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Имя клиента"
                  aria-label="Имя клиента"
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 py-3 pl-10 pr-4 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                />
              </div>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-400" />
                {/* +998 касса ставит сама — набирают девять цифр */}
                <span className="pointer-events-none absolute left-9 top-1/2 -translate-y-1/2 text-sm text-dark-400">{UZ_PREFIX}</span>
                <input
                  type="tel"
                  inputMode="numeric"
                  autoComplete="off"
                  value={formatLocal(customerPhone)}
                  onChange={(e) => setCustomerPhone(localDigits(e.target.value))}
                  placeholder="90 123-45-67"
                  aria-label="Телефон клиента, после +998"
                  className="w-full rounded border-2 border-dark-600 bg-dark-700 py-3 pl-20 pr-4 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowCustomerInput(false)} className="flex-1 rounded border border-dark-600 bg-dark-700 py-2.5 text-sm font-medium text-dark-300 hover:text-dark-50">Отмена</button>
              <button onClick={handleSaveCustomer} className="flex-1 rounded bg-primary-600 py-2.5 text-sm font-bold text-white hover:bg-primary-500">Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Main ═══ */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* ─── Заказ: справа, как деньги и оплата в «Магазине» ─── */}
        <aside className="order-2 flex w-[400px] shrink-0 flex-col border-l border-dark-700 bg-dark-900">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-dark-700 bg-dark-800 px-4">
            <span className="truncate text-sm text-dark-400">
              <b className="text-[15px] font-semibold text-dark-50">
                {orderType === "dine_in" ? (tableNumber ? `Стол ${tableNumber}` : "Без стола") : "Навынос"}
              </b>
              {getItemCount() > 0 ? ` · ${getItemCount()} шт.` : " · заказ"}
            </span>
            {items.length > 0 && (
              <button
                onClick={clearOrder}
                aria-label="Очистить заказ"
                title="Очистить заказ"
                className="-my-2 -mr-2 flex h-11 w-11 items-center justify-center rounded text-dark-400 transition-colors hover:bg-dark-700 hover:text-danger-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center text-dark-400">
                <ShoppingCart className="mb-2 h-12 w-12 opacity-30" />
                <p className="text-[15px] font-medium text-dark-300">Заказ пуст</p>
                <p className="text-sm">Нажмите на блюдо в меню</p>
              </div>
            ) : (
              <div>
                {items.map((item, index) => (
                  // Строка как в чеке: название и сумма, под ними количество × цена.
                  // Все кнопки — 44 px: планшет, спешка, палец (D-7).
                  <div key={item.id} className={`border-b border-dark-700/50 px-4 py-2.5 ${index % 2 ? "bg-dark-800/40" : ""}`}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug text-dark-50">{item.name}</p>
                        {item.modifiers?.length ? (
                          <p className="mt-0.5 truncate text-[11px] text-dark-400">{item.modifiers.map((m) => m.name).join(", ")}</p>
                        ) : null}
                      </div>
                      <span className="whitespace-nowrap text-sm font-bold text-dark-50">{money(item.price * item.quantity)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1">
                      <button
                        onClick={() => (item.quantity <= 1 ? removeLine(item.id) : updateQuantity(item.id, item.quantity - 1))}
                        aria-label={`Меньше: ${item.name}`}
                        className="flex h-11 w-11 items-center justify-center rounded-md bg-dark-700 text-dark-300 transition-colors hover:bg-dark-600 hover:text-dark-50 active:scale-95"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="w-9 text-center text-sm font-bold text-dark-50">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        aria-label={`Больше: ${item.name}`}
                        className="flex h-11 w-11 items-center justify-center rounded-md bg-primary-600 text-white transition-colors hover:bg-primary-500 active:scale-95"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <span className="ml-2 text-xs text-dark-400">× {money(item.price)}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => removeLine(item.id)}
                        aria-label={`Убрать: ${item.name}`}
                        className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md text-dark-400 transition-colors hover:bg-dark-700 hover:text-danger-500"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-dark-700 bg-dark-800 px-4 pb-4 pt-3">
            {customerName && (
              <div className="mb-1.5 flex items-center justify-between text-xs text-dark-400">
                <span>Клиент</span>
                <span className="font-medium text-dark-50">{customerName}</span>
              </div>
            )}
            {/* Итог — главная цифра экрана: число крупно, валюта мелко (D-7). */}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs uppercase tracking-[0.12em] text-dark-400">К оплате</span>
              <span className="whitespace-nowrap font-semibold leading-none tabular-nums text-dark-50">
                {!total.suffix && <span className="mr-1 text-xl font-medium text-dark-400">{total.symbol}</span>}
                <span className="text-[44px] tracking-tight">{total.figure}</span>
                {total.suffix && <span className="ml-1.5 text-lg font-medium text-dark-400">{total.symbol}</span>}
              </span>
            </div>
            <button
              onClick={onCheckout}
              disabled={items.length === 0}
              className="mt-3 flex h-16 w-full items-center gap-3 rounded bg-success-600 px-5 text-xl font-bold text-white transition-colors hover:bg-success-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Banknote className="h-6 w-6" />
              Оплатить
              <span className="ml-auto rounded-sm bg-black/25 px-2 py-0.5 text-xs font-semibold tracking-wide text-white">F8</span>
            </button>
          </div>
        </aside>

        {/* ─── Меню: поиск, категории — ряд клавиш, блюда — белые плитки ─── */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-dark-950">
          <div className="shrink-0 border-b border-dark-700 bg-dark-800 px-4 py-2.5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-400" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по меню"
                aria-label="Поиск по меню"
                className="h-11 w-full rounded border border-dark-600 bg-dark-900 pl-9 pr-14 text-[15px] text-dark-50 placeholder:text-dark-400 focus:border-primary-500 focus:outline-none"
              />
              {search ? (
                <button
                  onClick={() => setSearch("")}
                  aria-label="Очистить поиск"
                  className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded text-dark-400 hover:text-dark-50"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-sm border border-dark-600 px-1.5 text-[11px] font-semibold text-dark-400">
                  F3
                </span>
              )}
            </div>
          </div>

          {tabs.length > 0 && !search && (
            <div role="tablist" aria-label="Категории" className="flex h-14 shrink-0 gap-px overflow-x-auto bg-dark-700">
              {tabs.map((tab) => {
                const on = tab.id === activeCategory;
                return (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setSelectedCategory(tab.id)}
                    className={`relative min-w-[7.5rem] flex-1 whitespace-nowrap px-4 text-[15px] font-medium transition-colors ${
                      on ? "bg-key text-white" : "bg-fn text-fn-fg hover:bg-fn-hover"
                    }`}
                  >
                    {tab.name}
                    <span className="ml-1.5 text-xs opacity-90">{tab.count}</span>
                    {on && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex-1 overflow-y-auto bg-zebra p-3">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-dark-500 border-t-primary-500" />
              </div>
            ) : hasError ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
                <AlertCircle className="mb-2 h-10 w-10 text-danger-500" />
                <p className="text-[15px] font-medium text-dark-50">Меню не загрузилось</p>
                <p className="text-sm text-dark-400">{apiErrorMessage(catError || prodError, "Повторите через минуту")}</p>
              </div>
            ) : tabs.length === 0 && !search ? (
              // Новое кафе: меню ещё не заведено (D-8).
              <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
                <Package className="mb-2 h-10 w-10 text-dark-400" />
                <p className="text-[15px] font-medium text-dark-50">Меню пока пустое</p>
                <p className="max-w-sm text-sm text-dark-400">
                  Блюда заводятся в панели управления: «Товары» → «Добавить товар». Здесь они появятся сразу.
                </p>
              </div>
            ) : groupedProducts.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center text-dark-400">
                <Package className="mb-2 h-10 w-10 opacity-60" />
                <p className="text-[15px] font-medium text-dark-300">{search ? `По запросу «${search}» ничего нет` : "В этой категории пока пусто"}</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 content-start gap-2 lg:grid-cols-4 xl:grid-cols-5">
                {groupedProducts.map((variants) => {
                  const product = variants[0];
                  const totalQty = getTotalQtyForGroup(variants);
                  const hasVariants = variants.length > 1;
                  const out = !hasVariants && product.trackInventory && product.currentStock <= 0;
                  const low = !hasVariants && product.trackInventory && product.currentStock <= product.minStock;
                  return (
                    <button
                      key={product.id}
                      onClick={(e) => handleProductClick(variants, e)}
                      className={`relative flex min-h-[7rem] flex-col justify-between gap-2 rounded border bg-dark-800 p-3 text-left transition-colors active:bg-dark-700 ${
                        totalQty > 0 ? "border-sel ring-1 ring-sel" : "border-dark-600 hover:border-dark-400"
                      } ${out ? "opacity-55" : ""}`}
                    >
                      <span className="flex items-start gap-2 pr-8">
                        {product.imageUrl && <img src={product.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />}
                        <span className="line-clamp-2 text-[15px] font-medium leading-snug text-dark-50">{product.name}</span>
                      </span>
                      <span className="flex items-end justify-between gap-2">
                        <span className="text-[17px] font-semibold tabular-nums text-dark-50">
                          {hasVariants ? `от ${money(Math.min(...variants.map((v) => Number(v.price))))}` : money(Number(product.price))}
                        </span>
                        {hasVariants ? (
                          <span className="text-xs text-dark-400">{variants.length} вар.</span>
                        ) : product.trackInventory ? (
                          <span className={`text-xs font-medium ${out ? "text-danger-500" : low ? "text-warning-500" : "text-dark-400"}`}>
                            {out ? "нет" : `ост. ${product.currentStock}`}
                          </span>
                        ) : null}
                      </span>
                      {totalQty > 0 && (
                        <span className="absolute right-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-sm bg-primary-600 px-2 text-sm font-semibold tabular-nums text-white">
                          {totalQty}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ═══ Volume Picker — Modal (center screen) ═══ */}
      {volumePickerProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" style={{ animation: "fade-in 0.2s ease" }}>
          <div className="rounded-md border border-dark-600 bg-dark-800 shadow-2xl w-full max-w-lg" style={{ animation: "scale-in 0.2s ease" }}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-dark-700">
              <div>
                <h3 className="text-xl font-bold text-dark-50">{volumePickerProduct[0].name}</h3>
                <p className="text-sm text-dark-400">Выберите объём</p>
              </div>
              <button
                onClick={() => setVolumePickerProduct(null)}
                className="rounded p-2 text-dark-400 hover:bg-dark-700 hover:text-dark-50 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 p-6">
              {volumePickerProduct.map((variant) => {
                const qty = getQtyInCart(variant.id);
                return (
                  <button
                    key={variant.id}
                    onClick={() => handleSelectVolume(variant)}
                    className={`relative flex flex-col items-center gap-3 rounded border-2 px-6 py-8 transition-all active:scale-95 ${
                      qty > 0
                        ? "border-primary-500 bg-primary-600/10"
                        : "border-dark-600 bg-dark-700 hover:border-primary-500/50 hover:bg-dark-600"
                    }`}
                  >
                    {qty > 0 && (
                      <span className="absolute -right-2 -top-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-primary-500 px-2 text-xs font-bold text-white shadow-md">
                        {qty}
                      </span>
                    )}
                    <span className="text-3xl font-bold text-dark-50">{variant.volume || "—"}</span>
                    <span className="text-xl font-bold text-primary-400">{money(Number(variant.price))}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Portion Picker (for gram products) ═══ */}
      {portionPickerProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" style={{ animation: "fade-in 0.2s ease" }}>
          <div className="rounded-md border border-dark-600 bg-dark-800 shadow-2xl w-full max-w-md" style={{ animation: "scale-in 0.2s ease" }}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-dark-700">
              <div>
                <h3 className="text-xl font-bold text-dark-50">{portionPickerProduct.name}</h3>
                <p className="text-sm text-dark-400">Выберите порцию</p>
              </div>
              <button
                onClick={() => setPortionPickerProduct(null)}
                className="rounded p-2 text-dark-400 hover:bg-dark-700 hover:text-dark-50 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 p-6">
              {portionOptions.map((grams) => {
                const pricePerGram = Number(portionPickerProduct.price);
                const portionPrice = pricePerGram * grams;
                return (
                  <button
                    key={grams}
                    onClick={() => handlePortionSelect(portionPickerProduct, grams)}
                    className="flex flex-col items-center gap-2 rounded border-2 border-dark-600 bg-dark-700 px-6 py-6 transition-all hover:border-primary-500/50 hover:bg-dark-600 active:scale-95"
                  >
                    <span className="text-3xl font-bold text-dark-50">{grams} г</span>
                    <span className="text-lg font-bold text-primary-400">{money(portionPrice)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Stock Receipt (Приход) ═══ */}
      {showStockReceipt && <StockReceiptScreen onClose={() => setShowStockReceipt(false)} />}
    </div>
  );
}
