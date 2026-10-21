import axios from "axios";
import { FIELDS, autoMap, norm, type Cell, type FieldDef, type FieldKey } from "./productsFile";
import { apiErrorMessage } from "./apiError";
import type { ReceiptImportItem, ReceiptImportResult } from "../services";

// Приход из Excel: что панель решает сама, до и после сервера. Найти товары,
// посчитать суммы и проверить строки — дело сервера (POST /stock-receipts/import),
// здесь только какие колонки нужны и как показать ответ.

/** Сколько строк сервер принимает в один приход. */
export const MAX_RECEIPT_ROWS = 2000;

// Количество прихода — сколько пришло. В выгрузке товаров, куда владелец
// дописал «Количество», есть и «Остаток» — сколько было: он только запасной.
const QUANTITY_FIRST = ["количество", "кол-во", "кол", "qty"];

/**
 * Колонки те же, что у импорта товаров, — один и тот же файл понимают оба.
 * «Остаток» здесь — сколько пришло, если «Количества» нет; мин. остаток
 * приходу ни к чему.
 */
export const RECEIPT_FIELDS: FieldDef[] = FIELDS.filter((f) => f.key !== "minStock").map((f) =>
  f.key === "stock" ? { ...f, label: "Количество", synonyms: [...QUANTITY_FIRST, ...f.synonyms.filter((s) => !QUANTITY_FIRST.includes(s))] } : f
);

export const RECEIPT_KEYS: FieldKey[] = RECEIPT_FIELDS.map((f) => f.key);

/** Без количества и цены закупки приход не провести; название, штрихкод или артикул — хоть что-то одно. */
export const RECEIPT_REQUIRED: FieldKey[] = ["stock", "costPrice"];

// «Цена» без уточнения. В накладной поставщика («Наименование | Кол-во | Цена |
// Сумма») это цена закупки, а не продажи.
const BARE_PRICE = ["цена", "price", "narx"];
const SALE_PRICE = FIELDS.find((f) => f.key === "price")!
  .synonyms.filter((s) => !BARE_PRICE.includes(s))
  .map(norm);

/**
 * Колонки прихода по заголовкам. Голая «Цена» при отсутствии колонки закупки —
 * себестоимость: иначе цена из накладной ставилась ценой продажи, а
 * себестоимость приходилось выбирать из той же колонки.
 */
export function receiptAutoMap(headers: Cell[]): Record<FieldKey, number | null> {
  const mapping = autoMap(headers, RECEIPT_FIELDS);
  if (mapping.costPrice !== null || mapping.price === null) return mapping;
  const title = norm(String(headers[mapping.price] ?? ""));
  if (SALE_PRICE.some((s) => title.startsWith(s))) return mapping;
  return { ...mapping, costPrice: mapping.price, price: null };
}

/** Чего не хватает в сопоставлении колонок, чтобы проверить файл. */
export function mappingProblems(mapping: Record<FieldKey, number | null>): string[] {
  const problems: string[] = [];
  if (mapping.name === null && mapping.barcode === null && mapping.sku === null) problems.push("Укажите колонку с названием, штрихкодом или артикулом.");
  if (mapping.stock === null) problems.push("Укажите колонку с количеством — сколько пришло.");
  if (mapping.costPrice === null) problems.push("Укажите колонку с себестоимостью — ценой закупки.");
  return problems;
}

/** Провести можно только весь файл и только без ошибок: половина накладной на складе хуже, чем ни одной. */
export function canApply(summary: ReceiptImportResult["summary"]): boolean {
  return summary.error === 0 && summary.existing + summary.new > 0;
}

export const ITEM_KIND: Record<ReceiptImportItem["kind"], { label: string; variant: "success" | "warning" | "danger" }> = {
  existing: { label: "есть в базе", variant: "success" },
  // Жёлтым, как «новый» в ручном приходе: новый товар — повод проверить
  // название, вдруг это опечатка и в базе появится двойник.
  new: { label: "новый товар", variant: "warning" },
  error: { label: "ошибка", variant: "danger" },
};

export type ItemFilter = "all" | ReceiptImportItem["kind"];

/** Что приход сделает с ценой продажи — для колонки «Цена продажи». */
export type PriceView =
  | { kind: "change"; from: number; to: number }
  | { kind: "set"; to: number }
  | { kind: "keep"; current: number }
  | { kind: "markup" }
  | { kind: "none" };

export function priceView(item: ReceiptImportItem): PriceView {
  if (item.kind === "error") return { kind: "none" };
  const sale = item.salePrice ?? null;
  if (item.kind === "new") return sale === null ? { kind: "markup" } : { kind: "set", to: sale };
  if (sale !== null && item.priceChanged) return { kind: "change", from: item.currentPrice ?? 0, to: sale };
  if (sale !== null) return { kind: "set", to: sale };
  return item.currentPrice === null || item.currentPrice === undefined ? { kind: "none" } : { kind: "keep", current: item.currentPrice };
}

/** Ошибка проведения — словами для владельца магазина, а не для программиста. */
export function applyErrorMessage(error: unknown): string {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    const { response } = error;
    // Тот же ключ с другим телом: первый раз приход прошёл, но ответ не дошёл,
    // а потом поменяли поставщика или файл. Второй приход сервер не проведёт.
    if (response?.status === 422 && /idempotency/i.test(response.data?.error ?? "")) {
      return "Похоже, этот приход уже проведён — проверьте список приходов. Чтобы провести файл заново, откройте окно ещё раз";
    }
    // Нет ответа, шлюз ответил 502/504 своей страницей или сервер занят (503):
    // приход мог и записаться. Повтор в этом же окне — с тем же ключом, его
    // сервер узнает. Закрыть окно и загрузить файл снова — второй приход.
    if (!response || [502, 503, 504].includes(response.status) || typeof response.data?.error !== "string") {
      return "Сервер не ответил вовремя — нажмите «Провести» ещё раз в этом же окне: дважды приход не проведётся";
    }
  }
  return apiErrorMessage(error, "Не удалось провести приход");
}

/**
 * Проведение отказало по самому файлу (400): между проверкой и проведением
 * товары поменялись — завели второй «Тан 0,5 л», переименовали карточку.
 * Проверка заново покажет, какая строка теперь с ошибкой.
 */
export function shouldRecheck(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 400;
}

/** Пометка в скачанном файле: у ошибки — причина, у нового товара — почему он новый. */
export const NEW_PRODUCT_MARK = "новый товар — в базе нет товара с таким штрихкодом, артикулом или названием";

export function rowMarks(items: ReceiptImportItem[]): Map<number, string> {
  const marks = new Map<number, string>();
  for (const i of items) {
    if (i.kind === "error") marks.set(i.row, i.message ?? "ошибка");
    else if (i.kind === "new") marks.set(i.row, NEW_PRODUCT_MARK);
    else if (i.message) marks.set(i.row, i.message);
  }
  return marks;
}

/** Заметка прихода из файла — по ней узнаётся повторная загрузка того же файла. */
export const fileNote = (fileName: string) => `Из файла «${fileName}»`;

/** Приход из списка «Приходы» — сколько нужно, чтобы узнать уже проведённый файл. */
export interface RecentReceipt {
  id: string;
  invoiceNumber?: string | null;
  notes?: string | null;
  createdAt: string;
  items: { productId: string; quantity: number }[];
}

/** Сколько дней проведённый приход ещё сверяется с новым файлом. */
export const DUPLICATE_DAYS = 3;

/**
 * Похоже, этот файл уже проведён: недавний приход из файла с тем же именем
 * или с теми же товарами в тех же количествах (хотя бы 80% строк). Ключ
 * повтора живёт, пока открыто окно, а владелец исправляет название в файле и
 * загружает его заново — и без предупреждения остатки удваивались.
 */
export function findDuplicateReceipt(
  result: ReceiptImportResult,
  fileName: string,
  receipts: RecentReceipt[],
  now = Date.now()
): RecentReceipt | null {
  const lines = result.items.filter((i) => i.kind === "existing" && i.productId).map((i) => `${i.productId}:${i.quantity}`);
  const since = now - DUPLICATE_DAYS * 24 * 3600 * 1000;
  for (const receipt of receipts) {
    if (new Date(receipt.createdAt).getTime() < since) continue;
    if (fileName && receipt.notes === fileNote(fileName)) return receipt;
    if (lines.length === 0 || receipt.items.length === 0) continue;
    const theirs = new Set(receipt.items.map((i) => `${i.productId}:${i.quantity}`));
    const same = lines.filter((l) => theirs.has(l)).length;
    if (same >= 0.8 * Math.max(lines.length, receipt.items.length)) return receipt;
  }
  return null;
}
