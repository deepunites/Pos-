import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LogOut, Moon, PackagePlus, PauseCircle, Sun, Volume2, VolumeX } from "lucide-react";
import toast from "react-hot-toast";
import api from "../../services/api";
import { ConnectionDot } from "../../components/ConnectionStatus";
import { OfflineQueueChip } from "../../components/OfflineQueue";
import { useConnection } from "../../services/connection";
import { findInCatalog, loadCatalog, refreshCatalog, searchCatalog } from "../../services/offlineCatalog";
import { isNoConnection } from "../../utils/apiError";
import { apiErrorMessage } from "../../utils/apiError";
import { undoToast } from "../../utils/undoToast";
import { useCartStore } from "../../store/cartStore";
import { useThemeStore } from "../../store/themeStore";
import { useMoney } from "../../hooks/useMoney";
import { useDebounced } from "../../hooks/useDebounced";
import type { CartItem, CashShift, Product } from "../../types";
import { fetchNational } from "../../utils/national";
import { beep, setSoundEnabled, soundEnabled } from "../../utils/sound";
import { gramsPerUnit, kgToGrams, parseDecimal, pricePerKg, stockInKg, weightLineTotal } from "../../utils/weight";
import StockReceiptScreen from "../StockReceiptScreen";
import "./shop.css";
import CatalogAdd, { type CatalogHit } from "./CatalogAdd";
import NumberPad from "./NumberPad";
import QuickKeys from "./QuickKeys";
import Receipt from "./Receipt";
import SaleDone from "./SaleDone";
import ScanBar from "./ScanBar";
import ShopPayment, { type PayMode, type SaleResult } from "./ShopPayment";
import SidePanel from "./SidePanel";
import TileCatalog, { type TileFilter } from "./TileCatalog";
import { CustomerModal, ParkedModal } from "./Modals";
import { emojiFor, formatQty, productTitle, shelfPrice, stockLeft, weightUnit } from "./shopProduct";

interface ShopScreenProps {
  user: { firstName: string; lastName: string; email: string; role: string };
  shift: CashShift;
  onLogout: () => void;
  onCloseShift: () => void;
}

// Поиск товаров по словам: с сервера, а без связи — по каталогу на планшете (офлайн-режим).
async function searchProducts(term: string): Promise<Product[]> {
  try {
    return (await api.get("/products", { params: { search: term, limit: 8, isActive: true, isIngredient: false, sort: "name" } })).data.data as Product[];
  } catch (error) {
    if (isNoConnection(error)) return searchCatalog(await loadCatalog(), term);
    throw error;
  }
}

// Без связи остатки — из копии каталога и могут быть устаревшими: касса не
// отказывает, а предупреждает, и продажа уходит в минус с пометкой (решение
// владельца: покупатель у кассы важнее устаревшей цифры).
const offlineNow = () => useConnection.getState().problem !== null;

// "5*4780012340011" / "0,5×яблоки": a multiplier typed in front of the code.
const MULTIPLIER = /^(\d+(?:[.,]\d+)?)\s*[*×xх]\s*(.*)$/i;

function useClock(): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The register for a shop — the scanner-first "Чек" layout with the tile
 * catalogue one tap away. Everything the cashier does goes through one always
 * focused field: a barcode, a short code, a name, or "5*" to multiply the next
 * item. The screen answers with a tone, so nobody has to watch it.
 */
export default function ShopScreen({ user, shift, onLogout, onCloseShift }: ShopScreenProps) {
  const { money, parts, shopName, symbol } = useMoney();
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useThemeStore();
  const { items, parked, customerName, customerPhone, setCustomer, updateQuantity, removeItem, insertItem, parkCurrent, restoreParked, discardParked, getTotal } = useCartStore();
  const clock = useClock();

  const [query, setQuery] = useState("");
  const [armed, setArmed] = useState<number | null>(null);
  const [view, setView] = useState<"receipt" | "tiles">("receipt");
  const [filter, setFilter] = useState<TileFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [screenKeyboard, setScreenKeyboard] = useState(false);
  const [sound, setSound] = useState(soundEnabled);

  const [weightFor, setWeightFor] = useState<{ product: Product; lineId?: string; initialGrams?: number } | null>(null);
  const [qtyFor, setQtyFor] = useState<{ product: Product; line: CartItem } | null>(null);
  const [payMethod, setPayMethod] = useState<PayMode | null>(null);
  const [sale, setSale] = useState<SaleResult | null>(null);
  const [showParked, setShowParked] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showReceiptIn, setShowReceiptIn] = useState(false);
  // A scanned code the shop does not have yet, offered to the manager as a new product.
  const [newProduct, setNewProduct] = useState<{ code: string; hit: CatalogHit | null; multiplier: number | null } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const products = useRef(new Map<string, Product>()); // what the terminal has seen of each product (stock, price)
  const lookups = useRef(new Map<string, { at: number; product: Product | null }>());

  const modalOpen = Boolean(weightFor || qtyFor || payMethod || sale || showParked || showCustomer || showReceiptIn || newProduct);
  const canAddProducts = user.role === "admin" || user.role === "manager";
  const total = getTotal();

  // Retail orders are takeaway orders with no table — and a table left over
  // from a café session must not ride along.
  useEffect(() => {
    useCartStore.getState().setOrderType("takeaway");
    // A shop counter is lit and busy: light is the default here. A theme the
    // cashier chose before is stored and stays.
    try {
      if (!localStorage.getItem("pos-theme")) useThemeStore.getState().setTheme("light");
    } catch {
      // storage unavailable — keep the current theme
    }
  }, []);

  // ── подсказки при вводе названия ─────────────────────────────────────────
  const term = useMemo(() => {
    const m = query.match(MULTIPLIER);
    return (m ? m[2] : query).trim();
  }, [query]);
  const debouncedTerm = useDebounced(term, 180);
  const suggestOn = !modalOpen && term.length >= 2 && !/^[\d\s.,-]+$/.test(term);
  const { data: suggestData, isFetching: suggestFetching, error: suggestFailure } = useQuery<Product[]>({
    queryKey: ["shop-suggest", debouncedTerm],
    enabled: suggestOn && debouncedTerm.length >= 2,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    queryFn: () => searchProducts(debouncedTerm),
  });
  const suggestions = suggestOn ? suggestData ?? [] : [];
  // The list is kept from the previous word while the next one loads, so it can
  // be shown — but Enter may only pick from a list that belongs to what is typed now.
  const suggestFresh = suggestOn && debouncedTerm === term && !suggestFetching;
  // Новое слово — выделение подсказки снова с первой строки. Поправка во время
  // рендера (так советует React), а не эффектом с лишним проходом.
  const [indexFor, setIndexFor] = useState(debouncedTerm);
  if (indexFor !== debouncedTerm) {
    setIndexFor(debouncedTerm);
    setSuggestIndex(0);
  }

  // ── добавление товара ────────────────────────────────────────────────────
  const fail = useCallback((message: string, duration = 2600) => {
    beep("error");
    toast.error(message, { id: "shop-error", duration });
  }, []);

  // Без связи остатка по копии каталога не хватает — продаём в минус, но кассир это видит.
  const warnShort = useCallback((name: string) => {
    toast(`«${name}»: по последним данным на складе нет — продаём в минус, в отчёте будет пометка`, { id: "shop-short", icon: "⚠️", duration: 3500 });
  }, []);

  // Копия каталога для работы без связи: при входе, раз в 10 минут и когда связь вернулась.
  const offline = useConnection((s) => s.problem !== null);
  useEffect(() => {
    if (offline) return;
    void refreshCatalog();
    const timer = setInterval(() => void refreshCatalog(), 10 * 60_000);
    return () => clearInterval(timer);
  }, [offline]);

  const touched = useCallback((id: string) => {
    setSelectedId(id);
    setFlashId(id);
    beep("ok");
    window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1600);
  }, []);

  const addWeighed = useCallback(
    (product: Product, grams: number, mode: "add" | "set", lineId?: string) => {
      const unit = weightUnit(product);
      if (!unit) return;
      const store = useCartStore.getState();
      const left = stockLeft(product, store.items, mode === "set" ? lineId : undefined);
      if (product.trackInventory && grams / gramsPerUnit(unit) > left + 1e-9) {
        if (!offlineNow()) {
          fail(`«${product.name}»: осталось ${formatQty(stockInKg(Math.max(left, 0), unit))} кг`);
          return;
        }
        warnShort(product.name);
      }
      const id = store.addWeight(
        { productId: product.id, name: productTitle(product), rate: Number(product.price), weightUnit: unit, barcode: product.barcode ?? null, emoji: emojiFor(product) },
        grams,
        mode
      );
      touched(id);
    },
    [fail, touched, warnShort]
  );

  const addProduct = useCallback(
    (product: Product, multiplier: number | null = null) => {
      products.current.set(product.id, product);
      const store = useCartStore.getState();
      const left = stockLeft(product, store.items);
      if (product.trackInventory && left <= 0 && !offlineNow()) {
        fail(`«${product.name}» — нет в наличии`);
        return;
      }

      if (weightUnit(product)) {
        // Weighed goods: a typed multiplier is the weight in kilograms; otherwise ask for the weight.
        if (multiplier && multiplier > 0) addWeighed(product, kgToGrams(multiplier), "add");
        else setWeightFor({ product });
        return;
      }

      let qty = 1;
      if (multiplier !== null) {
        if (!Number.isInteger(multiplier) || multiplier < 1) {
          fail("Для штучного товара количество должно быть целым");
          return;
        }
        qty = multiplier;
      }
      if (qty > left) {
        if (!offlineNow()) {
          fail(`«${product.name}»: осталось ${formatQty(left)}`);
          return;
        }
        warnShort(product.name);
      }
      const id = store.addPieces(
        { productId: product.id, name: productTitle(product), price: Number(product.price), barcode: product.barcode ?? null, emoji: emojiFor(product) },
        qty
      );
      touched(id);
    },
    [addWeighed, fail, touched, warnShort]
  );

  // A tile / quick key uses the typed multiplier too, then drops it.
  const pick = useCallback(
    (product: Product) => {
      const multiplier = armed;
      setArmed(null);
      addProduct(product, multiplier);
    },
    [armed, addProduct]
  );

  // ── строка сканера: код, короткий код, название, «5*» ────────────────────
  const findByCode = useCallback(async (code: string): Promise<Product | null> => {
    const hit = lookups.current.get(code);
    if (hit && Date.now() - hit.at < (hit.product ? 30_000 : 4_000)) return hit.product;
    try {
      const res = await api.get("/products/lookup", { params: { code } });
      const product = res.data.data as Product;
      lookups.current.set(code, { at: Date.now(), product });
      return product;
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) {
        lookups.current.set(code, { at: Date.now(), product: null });
        return null;
      }
      if (isNoConnection(error)) return findInCatalog(await loadCatalog(), code);
      throw error;
    }
  }, []);

  // A code the shop does not sell yet. If it is a real barcode the shared catalogue
  // is asked; a manager gets the name filled in and only types the price, a cashier
  // is told what the item is and whom to ask.
  const offerCatalog = useCallback(
    async (code: string, multiplier: number | null) => {
      if (offlineNow()) {
        fail(`Товар «${code}» не найден — без связи новый товар не добавить`, 4500);
        return;
      }
      let answer: (CatalogHit | { found: false; valid: boolean }) | null = null;
      // A code nobody has seen may take a few seconds (the public catalogues are asked) — say so.
      const hint = window.setTimeout(() => toast.loading("Ищу товар в общей базе…", { id: "shop-lookup" }), 500);
      try {
        // The register asks the national catalogue itself (the server cannot always reach it) and passes the record on.
        const national = await fetchNational(code);
        answer = (await api.post("/catalog/lookup", { code, ...(national ? { national } : {}) })).data.data;
      } catch {
        answer = null; // no network beyond the shop's own server — treat as unknown
      } finally {
        window.clearTimeout(hint);
        toast.dismiss("shop-lookup");
      }
      if (!answer || (!answer.found && !answer.valid)) {
        fail(`Товар «${code}» не найден`);
        return;
      }
      if (!canAddProducts) {
        fail(
          answer.found
            ? `«${answer.displayName}» есть в общей базе, но не в вашей кассе — попросите администратора добавить цену`
            : `Штрихкод ${code} не найден — попросите администратора добавить товар`,
          4500
        );
        return;
      }
      setNewProduct({ code, hit: answer.found ? answer : null, multiplier });
    },
    [canAddProducts, fail]
  );

  // Обработчики клавиатуры читают последние значения отсюда. Пишутся они после
  // фиксации рендера (useLayoutEffect — раньше любых событий и эффектов), а не во
  // время рендера: рендер, который React отбросит, не должен их перезаписать.
  const live = useRef({ query, armed, suggestions, suggestFresh, suggestIndex, items, modalOpen, selectedId, payMethod });
  useLayoutEffect(() => {
    live.current = { query, armed, suggestions, suggestFresh, suggestIndex, items, modalOpen, selectedId, payMethod };
  });

  const submit = useCallback(async () => {
    const state = live.current;
    const raw = (inputRef.current?.value ?? state.query).trim();
    if (!raw) return;
    // The field is emptied at once, before anything is awaited: a scanner may
    // deliver the next code while this one is still being looked up.
    setQuery("");
    setSuggestIndex(0);

    const typed = raw.match(MULTIPLIER);
    let multiplier = state.armed;
    let text = raw;
    if (typed) {
      multiplier = parseDecimal(typed[1]);
      text = typed[2].trim();
    }
    if (!text) {
      setArmed(multiplier && multiplier > 0 ? multiplier : null); // just "5*" — arm it for the next item
      return;
    }
    setArmed(null);

    const isCode = /^[\d\-.]+$/.test(text) || /^[A-Za-z0-9\-_.]+$/.test(text);
    if (state.suggestFresh && state.suggestions.length > 0 && !/^\d+$/.test(text)) {
      addProduct(state.suggestions[Math.min(state.suggestIndex, state.suggestions.length - 1)], multiplier);
      return;
    }

    try {
      const byCode = isCode ? await findByCode(text) : null;
      if (byCode) {
        addProduct(byCode, multiplier);
        return;
      }
      const found = await searchProducts(text);
      if (found.length === 1) {
        addProduct(found[0], multiplier);
      } else if (found.length > 1) {
        // Several matches — put the words back so the list opens and the cashier chooses.
        setQuery(text);
        setArmed(multiplier);
        beep("error");
      } else if (/^\d{8,14}$/.test(text)) {
        await offerCatalog(text, multiplier);
      } else {
        fail(`Товар «${text}» не найден`);
      }
    } catch (error) {
      fail(apiErrorMessage(error, "Не удалось найти товар — повторите"));
    }
  }, [addProduct, fail, findByCode, offerCatalog]);

  // ── правая клавиатура: набирает в поле сканера ───────────────────────────
  const focusField = useCallback(() => inputRef.current?.focus(), []);
  const keyPress = useCallback(
    (key: string) => {
      setQuery((current) => current + key);
      focusField();
    },
    [focusField]
  );
  const backspace = useCallback(() => {
    setQuery((current) => current.slice(0, -1));
    focusField();
  }, [focusField]);
  const clearField = useCallback(() => {
    setQuery("");
    setArmed(null);
    focusField();
  }, [focusField]);
  const multiply = useCallback(() => {
    const value = parseDecimal(live.current.query);
    if (value > 0) {
      setArmed(value);
      setQuery("");
    } else {
      fail("Наберите количество (или вес в кг), потом нажмите ×");
    }
    focusField();
  }, [fail, focusField]);

  // ── строки чека ──────────────────────────────────────────────────────────
  const removeLine = useCallback(
    (id: string) => {
      const list = useCartStore.getState().items;
      const index = list.findIndex((i) => i.id === id);
      if (index < 0) return;
      const line = list[index];
      removeItem(id);
      setSelectedId(list[index + 1]?.id ?? list[index - 1]?.id ?? null);
      undoToast(`«${line.name}» убрана`, () => {
        insertItem(line, index);
        setSelectedId(line.id);
      });
    },
    [insertItem, removeItem]
  );

  const step = useCallback(
    (id: string, delta: 1 | -1) => {
      const line = useCartStore.getState().items.find((i) => i.id === id);
      if (!line) return;
      if (delta === -1 && line.quantity <= 1) {
        removeLine(id);
        return;
      }
      const product = products.current.get(line.productId);
      if (delta === 1 && product && product.trackInventory && stockLeft(product, useCartStore.getState().items) < 1) {
        if (!offlineNow()) {
          fail(`«${line.name}»: больше нет на складе`);
          return;
        }
        warnShort(line.name);
      }
      updateQuantity(id, line.quantity + delta);
      setSelectedId(id);
    },
    [fail, removeLine, updateQuantity, warnShort]
  );

  const fetchProduct = useCallback(async (id: string): Promise<Product | null> => {
    try {
      const product = (await api.get(`/products/${id}`)).data.data as Product;
      products.current.set(id, product);
      return product;
    } catch (error) {
      if (isNoConnection(error)) {
        const cached = (await loadCatalog())?.products.find((p) => p.id === id) ?? null;
        if (cached) {
          products.current.set(id, cached);
          return cached;
        }
      }
      toast.error(apiErrorMessage(error, "Не удалось загрузить товар"));
      return null;
    }
  }, []);

  const editWeight = useCallback(
    async (id: string) => {
      const line = useCartStore.getState().items.find((i) => i.id === id);
      if (!line?.grams) return;
      const product = products.current.get(line.productId) ?? (await fetchProduct(line.productId));
      if (product) setWeightFor({ product, lineId: id, initialGrams: line.grams });
    },
    [fetchProduct]
  );

  const editQty = useCallback(
    async (id: string) => {
      const line = useCartStore.getState().items.find((i) => i.id === id);
      if (!line) return;
      const product = products.current.get(line.productId) ?? (await fetchProduct(line.productId));
      if (product) setQtyFor({ product, line });
    },
    [fetchProduct]
  );

  // ── отложить / оплата ────────────────────────────────────────────────────
  const park = useCallback(() => {
    if (parkCurrent()) {
      setSelectedId(null);
      beep("ok");
      toast.success("Чек отложен", { id: "shop-park", duration: 1600 });
    } else {
      fail("Чек пуст — откладывать нечего");
    }
  }, [fail, parkCurrent]);

  const openPay = useCallback(
    (method: PayMode) => {
      if (useCartStore.getState().items.length === 0) {
        fail("Чек пуст");
        return;
      }
      if (method !== "cash" && offlineNow()) {
        fail("Без связи — только наличные: картой оплатить нельзя");
        return;
      }
      setPayMethod(method);
    },
    [fail]
  );

  const onPaid = useCallback((result: SaleResult) => {
    lookups.current.clear();
    products.current.clear();
    setPayMethod(null);
    setSelectedId(null);
    setSale(result);
    beep("done");
  }, []);

  const nextCheck = useCallback(
    (carry?: string) => {
      setSale(null);
      setView("receipt");
      if (carry) setQuery(carry);
      window.setTimeout(focusField, 0);
    },
    [focusField]
  );

  // ── клавиатура: сканер «печатает» в любой момент ─────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;

      // While paying, F8–F10 switch the method rather than open a second one.
      // QR (когда его вернут) — без своей клавиши: F10 теперь «Карта + наличные».
      const byKey: Record<string, PayMode> = { F8: "cash", F9: "card", F10: "mixed" };
      if (s.payMethod && byKey[e.key]) {
        e.preventDefault();
        setPayMethod(byKey[e.key]);
        return;
      }
      if (s.modalOpen) return;

      if (byKey[e.key]) {
        e.preventDefault();
        openPay(byKey[e.key]);
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        park();
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        focusField();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const active = document.activeElement as HTMLElement | null;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || Boolean(active?.isContentEditable);
      const inScan = active === inputRef.current;

      if (e.key === "Escape") {
        setQuery("");
        setArmed(null);
        return;
      }
      // With an empty field the arrows walk the check and Delete drops the line.
      if ((!inField || inScan) && s.query === "" && s.items.length > 0) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const index = s.items.findIndex((i) => i.id === s.selectedId);
          const next = e.key === "ArrowUp" ? (index <= 0 ? s.items.length - 1 : index - 1) : index < 0 || index >= s.items.length - 1 ? 0 : index + 1;
          setSelectedId(s.items[next].id);
          return;
        }
        if (e.key === "Delete" && s.selectedId) {
          e.preventDefault();
          removeLine(s.selectedId);
          return;
        }
      }
      if (inField) return; // the field (or a real input) handles its own typing

      // Focus was somewhere else (a button, the page): a printable key belongs to the scan field.
      if (e.key.length === 1 && e.key !== " ") {
        e.preventDefault();
        focusField();
        setQuery((current) => current + e.key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setQuery((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusField, openPay, park, removeLine, submit]);

  // The field owns the keyboard whenever no window is open — and lets go of it
  // the moment one opens, or the digits typed into the window would also land
  // in the field behind it.
  useEffect(() => {
    if (modalOpen) inputRef.current?.blur();
    else focusField();
  }, [modalOpen, view, focusField]);

  useEffect(() => {
    if (selectedId) document.querySelector(`[data-line="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, items.length]);

  const lastLine = items[items.length - 1];
  const weighedPrice = weightFor ? pricePerKg(Number(weightFor.product.price), weightUnit(weightFor.product) ?? "кг") : 0;
  const hhmm = clock.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className="sh"
      // Tapping away from the field abandons what was half-typed (and closes
      // the suggestion list). The keypad and the field itself are exempt: they
      // are how the text is typed.
      onPointerDownCapture={(e) => {
        if (live.current.query && !(e.target as HTMLElement).closest(".sh-scan, .sh-pad, .sh-kd")) setQuery("");
      }}
      onPointerUp={() =>
        window.setTimeout(() => {
          const el = document.activeElement;
          if (!live.current.modalOpen && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) focusField();
        }, 0)
      }
    >
      <header className="sh-top">
        <div className="sh-logo">Qwik</div>
        <div className="sh-shop">{shopName}</div>
        <div className="sh-sp" />
        <button className="sh-chip" onClick={park} title="F2">
          <PauseCircle className="i" />
          Отложить
          <span className="sh-chip-fk">F2</span>
        </button>
        {parked.length > 0 && (
          <button className="sh-chip" onClick={() => setShowParked(true)}>
            Отложено
            <span className="sh-badge">{parked.length}</span>
          </button>
        )}
        <button className="sh-chip" onClick={() => setShowReceiptIn(true)} title="Оформить приход товара">
          <PackagePlus className="i" />
          Приход
        </button>
        <span className="sh-vr" />
        <button className="sh-chip" onClick={onCloseShift} title="Закрыть смену">
          <span className="sh-dot" />
          Смена от {new Date(shift.openedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          <Lock className="i" />
        </button>
        <OfflineQueueChip />
        <ConnectionDot />
        <span className="sh-time tab">{hhmm}</span>
        <button
          className="sh-ic"
          onClick={() => {
            setSoundEnabled(!sound);
            setSound(!sound);
          }}
          title={sound ? "Выключить звук сканера" : "Включить звук сканера"}
        >
          {sound ? <Volume2 className="i" /> : <VolumeX className="i" />}
        </button>
        <button className="sh-ic" onClick={toggleTheme} title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}>
          {theme === "dark" ? <Sun className="i" /> : <Moon className="i" />}
        </button>
        <span className="sh-who">
          <span className="sh-av">{`${user.firstName[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase()}</span>
          {user.firstName}
        </span>
        <button className="sh-ic" onClick={onLogout} title="Выйти">
          <LogOut className="i" />
        </button>
      </header>

      <div className="sh-main">
        <section className="sh-left">
          <ScanBar
            inputRef={inputRef}
            value={query}
            onChange={setQuery}
            onEnter={() => void submit()}
            onArrow={(direction) => setSuggestIndex((i) => Math.max(0, Math.min(suggestions.length - 1, i + direction)))}
            onEscape={() => {
              setQuery("");
              setArmed(null);
            }}
            suggestions={suggestions}
            suggestOpen={suggestOn}
            suggestLoading={suggestFetching}
            // Без связи «Ничего не найдено» — неправда: товар есть, его просто не спросить.
            suggestError={suggestFailure ? apiErrorMessage(suggestFailure, "Поиск не сработал — повторите") : null}
            suggestIndex={suggestIndex}
            onSuggestIndex={setSuggestIndex}
            onPick={(product) => {
              const typed = query.match(MULTIPLIER);
              const multiplier = typed ? parseDecimal(typed[1]) : armed;
              setQuery("");
              setArmed(null);
              addProduct(product, multiplier);
              focusField();
            }}
            view={view}
            onToggleView={() => setView((v) => (v === "receipt" ? "tiles" : "receipt"))}
            screenKeyboard={screenKeyboard}
            onToggleKeyboard={() => setScreenKeyboard((on) => !on)}
            money={money}
          />

          {view === "receipt" ? (
            <>
              <Receipt
                items={items}
                selectedId={selectedId}
                flashId={flashId}
                money={money}
                onSelect={setSelectedId}
                onStep={step}
                onEditQty={(id) => void editQty(id)}
                onEditWeight={(id) => void editWeight(id)}
                onRemove={removeLine}
              />
              <QuickKeys
                money={money}
                onPick={pick}
                onOpenWeighed={() => {
                  setFilter("weighed");
                  setView("tiles");
                }}
              />
            </>
          ) : (
            <>
              <TileCatalog filter={filter} onFilter={setFilter} items={items} parts={parts} onPick={pick} />
              <div className="sh-strip">
                <span>
                  В чеке <b className="tab">{items.length}</b> {items.length === 1 ? "позиция" : "позиций"}
                </span>
                {lastLine && <span className="last">последняя: {lastLine.name}</span>}
                {!lastLine && <span className="last" />}
                <button onClick={() => setView("receipt")}>Показать чек →</button>
              </div>
            </>
          )}
        </section>

        {payMethod ? (
          <ShopPayment key={payMethod} mode={payMethod} total={total} shiftId={shift.id} onClose={() => setPayMethod(null)} onPaid={onPaid} />
        ) : (
          <SidePanel
            total={total}
            positions={items.length}
            customerName={customerName}
            parts={parts}
            armed={armed}
            onDisarm={() => setArmed(null)}
            onKey={keyPress}
            onBackspace={backspace}
            onClear={clearField}
            onMultiply={multiply}
            onEnter={() => void submit()}
            onCustomer={() => setShowCustomer(true)}
            onPay={openPay}
            canPay={items.length > 0}
            offline={offline}
          />
        )}
      </div>

      {weightFor && (
        <NumberPad
          mode="weight"
          title={productTitle(weightFor.product)}
          emoji={emojiFor(weightFor.product)}
          imageUrl={weightFor.product.imageUrl}
          subtitle={`${money(weighedPrice)} за кг${weightFor.product.trackInventory ? ` · остаток ${formatQty(stockInKg(Number(weightFor.product.currentStock), weightUnit(weightFor.product) ?? "кг"))} кг` : ""}`}
          initial={weightFor.initialGrams ? weightFor.initialGrams / 1000 : undefined}
          unitLabel="кг"
          quick={[0.25, 0.5, 1, 2, 5]}
          total={(kg) => weightLineTotal(Number(weightFor.product.price), kgToGrams(kg), weightUnit(weightFor.product) ?? "кг")}
          max={(() => {
            const unit = weightUnit(weightFor.product) ?? "кг";
            return stockInKg(stockLeft(weightFor.product, items, weightFor.lineId), unit);
          })()}
          maxHint={`Осталось ${formatQty(Math.max(0, stockInKg(stockLeft(weightFor.product, items, weightFor.lineId), weightUnit(weightFor.product) ?? "кг")))} кг`}
          confirmLabel={weightFor.lineId ? "Изменить вес" : "Добавить в чек"}
          money={money}
          onClose={() => setWeightFor(null)}
          onConfirm={(kg) => {
            const target = weightFor;
            setWeightFor(null);
            addWeighed(target.product, kgToGrams(kg), target.lineId ? "set" : "add", target.lineId);
          }}
        />
      )}

      {qtyFor && (
        <NumberPad
          mode="count"
          title={qtyFor.line.name}
          emoji={qtyFor.line.emoji ?? emojiFor(qtyFor.product)}
          imageUrl={qtyFor.product.imageUrl}
          subtitle={`${money(shelfPrice(qtyFor.product).amount)} за шт${qtyFor.product.trackInventory ? ` · остаток ${formatQty(Number(qtyFor.product.currentStock))}` : ""}`}
          initial={qtyFor.line.quantity}
          unitLabel="шт"
          quick={[1, 2, 3, 5, 10]}
          total={(count) => Math.round(qtyFor.line.price * count * 100) / 100}
          max={stockLeft(qtyFor.product, items, qtyFor.line.id)}
          maxHint={`Осталось ${formatQty(Math.max(0, stockLeft(qtyFor.product, items, qtyFor.line.id)))} шт`}
          confirmLabel="Изменить"
          money={money}
          onClose={() => setQtyFor(null)}
          onConfirm={(count) => {
            updateQuantity(qtyFor.line.id, count);
            setSelectedId(qtyFor.line.id);
            setQtyFor(null);
          }}
        />
      )}

      {sale && <SaleDone result={sale} onNext={nextCheck} />}

      {showParked && (
        <ParkedModal
          parked={parked}
          hasCurrent={items.length > 0}
          money={money}
          onRestore={(id) => {
            restoreParked(id);
            setShowParked(false);
            setSelectedId(null);
          }}
          onDiscard={discardParked}
          onClose={() => setShowParked(false)}
        />
      )}
      {showCustomer && (
        <CustomerModal
          name={customerName}
          phone={customerPhone}
          onSave={(name, phone) => {
            setCustomer(name, phone);
            setShowCustomer(false);
          }}
          onClose={() => setShowCustomer(false)}
        />
      )}
      {showReceiptIn && <StockReceiptScreen onClose={() => setShowReceiptIn(false)} />}
      {newProduct && (
        <CatalogAdd
          code={newProduct.code}
          hit={newProduct.hit}
          symbol={symbol}
          onClose={() => setNewProduct(null)}
          onAdded={(product) => {
            const { code, multiplier } = newProduct;
            setNewProduct(null);
            lookups.current.set(code, { at: Date.now(), product });
            for (const key of ["shop-tiles", "shop-quick", "categories"]) queryClient.invalidateQueries({ queryKey: [key] });
            toast.success(`Добавлено в кассу: ${product.name}`, { id: "shop-added", duration: 2200 });
            addProduct(product, multiplier);
          }}
        />
      )}
    </div>
  );
}
