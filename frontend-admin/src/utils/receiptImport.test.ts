import { describe, it, expect } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { autoMap, toImportRows } from "./productsFile";
import {
  NEW_PRODUCT_MARK,
  RECEIPT_FIELDS,
  RECEIPT_KEYS,
  applyErrorMessage,
  canApply,
  fileNote,
  findDuplicateReceipt,
  mappingProblems,
  priceView,
  receiptAutoMap,
  rowMarks,
  shouldRecheck,
  type RecentReceipt,
} from "./receiptImport";
import type { ReceiptImportItem, ReceiptImportResult } from "../services";

// Приход из Excel: какие колонки нужны и как показать ответ сервера.

// Так выглядит настоящий файл владельца магазина: без штрихкода и артикула,
// количество названо «Остаток».
const OWNER_HEADERS = ["Название", "Категория", "Ед. измерения", "Остаток", "Себестоимость", "Цена продажи"];

describe("columns", () => {
  it("calls the stock column «Количество» and leaves min. stock out", () => {
    expect(RECEIPT_FIELDS.find((f) => f.key === "stock")?.label).toBe("Количество");
    expect(RECEIPT_KEYS).not.toContain("minStock");
    expect(RECEIPT_KEYS).toEqual(["name", "barcode", "sku", "price", "costPrice", "stock", "unit", "category"]);
  });

  it("understands the owner's file and sends its rows as they are", () => {
    const mapping = receiptAutoMap(OWNER_HEADERS);
    expect(mapping).toMatchObject({ name: 0, category: 1, unit: 2, stock: 3, costPrice: 4, price: 5, barcode: null, sku: null });
    expect(mappingProblems(mapping)).toEqual([]);
    const rows = toImportRows([OWNER_HEADERS, ["Coca-Cola 0,5 л", "Напитки", "шт", 5, 6000, 8000]], 0, mapping);
    expect(rows).toEqual([{ row: 2, name: "Coca-Cola 0,5 л", category: "Напитки", unit: "шт", stock: 5, costPrice: 6000, price: 8000 }]);
  });

  it("takes «Количество» and «Кол-во» for the quantity too", () => {
    expect(receiptAutoMap(["Товар", "Количество", "Цена закупки"])).toMatchObject({ name: 0, stock: 1, costPrice: 2 });
    expect(receiptAutoMap(["Наименование", "Кол-во", "Себестоимость"])).toMatchObject({ name: 0, stock: 1, costPrice: 2 });
  });

  it("prefers «Количество» to «Остаток» wherever the columns stand", () => {
    // Своя выгрузка товаров, справа дописано, сколько пришло.
    const ours = ["Название", "Штрихкод", "Артикул", "Категория", "Ед. изм.", "Цена продажи", "Себестоимость", "Остаток", "Мин. остаток", "ИКПУ", "Количество"];
    expect(receiptAutoMap(ours)).toMatchObject({ stock: 10, minStock: null, price: 5, costPrice: 6 });
    // Импорт товаров ставит остаток — ему по-прежнему нужен «Остаток».
    expect(autoMap(ours)).toMatchObject({ stock: 7, minStock: 8 });
    expect(receiptAutoMap(["Кол-во", "Название", "Остаток", "Себестоимость"])).toMatchObject({ stock: 0 });
  });

  it("reads a bare «Цена» of a supplier's invoice as the purchase price", () => {
    expect(receiptAutoMap(["Наименование", "Кол-во", "Цена", "Сумма"])).toMatchObject({ name: 0, stock: 1, costPrice: 2, price: null });
    expect(receiptAutoMap(["Наименование", "Кол-во", "Цена, сўм"])).toMatchObject({ costPrice: 2, price: null });
    // Есть колонка закупки — «Цена» рядом с ней это цена продажи.
    expect(receiptAutoMap(["Название", "Себестоимость", "Цена"])).toMatchObject({ costPrice: 1, price: 2 });
    // «Розничная цена» — продажа, даже без колонки закупки: её владелец укажет сам.
    const retail = receiptAutoMap(["Товар", "Количество", "Розничная цена"]);
    expect(retail).toMatchObject({ price: 2, costPrice: null });
    expect(mappingProblems(retail)).toEqual(["Укажите колонку с себестоимостью — ценой закупки."]);
  });

  it("names what is missing", () => {
    const none = autoMap([]);
    expect(mappingProblems(none)).toHaveLength(3);
    // Штрихкода хватает, чтобы найти товар; без количества и цены закупки — нет.
    expect(mappingProblems({ ...none, barcode: 0, stock: 1 })).toEqual(["Укажите колонку с себестоимостью — ценой закупки."]);
  });
});

describe("apply", () => {
  const summary = { existing: 3, new: 2, error: 0, quantity: 30, totalCost: 150_000, totalSale: 210_000 };

  it("is allowed only for a clean file with something to receive", () => {
    expect(canApply(summary)).toBe(true);
    expect(canApply({ ...summary, error: 1 })).toBe(false);
    expect(canApply({ ...summary, existing: 0, new: 0 })).toBe(false);
  });
});

describe("sale price column", () => {
  const base: ReceiptImportItem = { row: 2, kind: "existing", name: "Чай", quantity: 5, costPrice: 6000, sum: 30_000 };

  it("shows was → will be when the file changes the shelf price", () => {
    expect(priceView({ ...base, salePrice: 8000, currentPrice: 7000, priceChanged: true })).toEqual({ kind: "change", from: 7000, to: 8000 });
  });

  it("shows the price when it stays the same or the file has none", () => {
    expect(priceView({ ...base, salePrice: 8000, currentPrice: 8000, priceChanged: false })).toEqual({ kind: "set", to: 8000 });
    expect(priceView({ ...base, salePrice: null, currentPrice: 7000 })).toEqual({ kind: "keep", current: 7000 });
  });

  it("a new product without a price gets one from the category markup", () => {
    expect(priceView({ ...base, kind: "new", salePrice: null })).toEqual({ kind: "markup" });
    expect(priceView({ ...base, kind: "new", salePrice: 9000 })).toEqual({ kind: "set", to: 9000 });
  });

  it("an error row has no price", () => {
    expect(priceView({ row: 3, kind: "error", name: "", message: "нет количества" })).toEqual({ kind: "none" });
  });
});

describe("apply errors", () => {
  const httpError = (status: number, error: string) =>
    new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
      status,
      statusText: "",
      data: { success: false, error },
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

  it("passes the server's own words through", () => {
    expect(applyErrorMessage(httpError(400, "В файле есть ошибки — исправьте строки и загрузите снова"))).toBe(
      "В файле есть ошибки — исправьте строки и загрузите снова"
    );
  });

  it("explains a reused key instead of showing «Idempotency-Key»", () => {
    const message = applyErrorMessage(httpError(422, "Этот Idempotency-Key уже использован для другого запроса"));
    expect(message).toMatch(/уже проведён/);
    expect(message).not.toMatch(/Idempotency/);
  });

  it("tells that pressing again after a lost answer is safe", () => {
    expect(applyErrorMessage(new AxiosError("timeout", "ECONNABORTED"))).toMatch(/ещё раз в этом же окне/);
  });

  it("says the same when the gateway answers instead of the server", () => {
    const gateway = (status: number, data: unknown) =>
      new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, { status, statusText: "", data, headers: {}, config: { headers: new AxiosHeaders() } });
    expect(applyErrorMessage(gateway(504, "<html>Gateway Timeout</html>"))).toMatch(/ещё раз в этом же окне/);
    expect(applyErrorMessage(gateway(502, ""))).toMatch(/ещё раз в этом же окне/);
    expect(applyErrorMessage(httpError(503, "Сервер занят — повторите через несколько секунд"))).toMatch(/ещё раз в этом же окне/);
  });

  it("checks the file again when the server refused it, and only then", () => {
    expect(shouldRecheck(httpError(400, "В файле есть ошибки — исправьте строки и загрузите снова"))).toBe(true);
    expect(shouldRecheck(httpError(422, "Этот Idempotency-Key уже использован для другого запроса"))).toBe(false);
    expect(shouldRecheck(new AxiosError("timeout", "ECONNABORTED"))).toBe(false);
  });
});

describe("marked file", () => {
  it("marks errors with the reason and new goods as new", () => {
    const marks = rowMarks([
      { row: 2, kind: "error", name: "", message: "нет количества" },
      { row: 3, kind: "new", name: "Coca Cola 0,5л" },
      { row: 4, kind: "existing", name: "Чай" },
      { row: 5, kind: "existing", name: "Сок", message: "снят с продажи — вернётся в продажу" },
    ]);
    expect([...marks]).toEqual([
      [2, "нет количества"],
      [3, NEW_PRODUCT_MARK],
      [5, "снят с продажи — вернётся в продажу"],
    ]);
  });
});

describe("the same file twice", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
  const check = (lines: [string, number][], extra: ReceiptImportItem[] = []): ReceiptImportResult => ({
    applied: false,
    summary: { existing: lines.length, new: extra.length, error: 0, quantity: 0, totalCost: 0, totalSale: 0 },
    items: [...lines.map(([productId, quantity], i) => ({ row: i + 2, kind: "existing" as const, name: productId, productId, quantity })), ...extra],
  });
  const receipt = (createdAt: string, items: [string, number][], notes: string | null = null): RecentReceipt => ({
    id: createdAt,
    invoiceNumber: "ПР-0043",
    notes,
    createdAt,
    items: items.map(([productId, quantity]) => ({ productId, quantity })),
  });
  const drinks: [string, number][] = [["cola", 5], ["fanta", 6], ["sprite", 7], ["pepsi", 5], ["burn", 7]];

  it("knows a receipt booked from the same file, even when every row is new now", () => {
    const booked = receipt(hoursAgo(20), [["x", 1]], fileNote("Приход 20.10.xlsx"));
    const typoFixed = check([], [{ row: 2, kind: "new", name: "Coca-Cola 0,5 л", quantity: 5 }]);
    expect(findDuplicateReceipt(typoFixed, "Приход 20.10.xlsx", [booked], now)).toBe(booked);
    expect(findDuplicateReceipt(typoFixed, "Приход 21.10.xlsx", [booked], now)).toBeNull();
  });

  it("knows a receipt with the same goods in the same quantities, whatever the file is called", () => {
    const booked = receipt(hoursAgo(2), drinks);
    expect(findDuplicateReceipt(check(drinks), "копия.xlsx", [booked], now)).toBe(booked);
    // Одно название исправили — оно нашло другой товар: всё равно тот же файл.
    expect(findDuplicateReceipt(check([...drinks.slice(0, 4), ["burn-new", 7]]), "копия.xlsx", [booked], now)).toBe(booked);
    // Другие количества — другая поставка.
    expect(findDuplicateReceipt(check(drinks.map(([id]) => [id, 12])), "копия.xlsx", [booked], now)).toBeNull();
  });

  it("forgets receipts older than a few days", () => {
    const old = receipt(hoursAgo(24 * 4), drinks, fileNote("Приход.xlsx"));
    expect(findDuplicateReceipt(check(drinks), "Приход.xlsx", [old], now)).toBeNull();
  });
});
