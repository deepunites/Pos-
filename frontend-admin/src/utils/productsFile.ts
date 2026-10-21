// Файлы товаров: чтение Excel/CSV для импорта (своя выгрузка, шаблон, файл из
// 1С и других программ) и выгрузка в Excel/CSV. Библиотеки Excel грузятся
// только когда ими пользуются — в основной бандл админки они не попадают.

export type FieldKey = "name" | "barcode" | "sku" | "price" | "costPrice" | "stock" | "unit" | "category" | "minStock";

export interface FieldDef {
  key: FieldKey;
  label: string;
  required?: boolean;
  /** Как эту колонку называют в наших выгрузках, в 1С и в других программах. */
  synonyms: string[];
}

export const FIELDS: FieldDef[] = [
  { key: "name", label: "Название", required: true, synonyms: ["название", "наименование", "номенклатура", "товар", "наименование товара", "полное наименование", "name", "nomi"] },
  { key: "barcode", label: "Штрихкод", synonyms: ["штрихкод", "штрих-код", "штрих код", "шк", "ean", "barcode", "штрихкоды"] },
  { key: "sku", label: "Артикул / код", synonyms: ["артикул", "код", "код товара", "sku", "plu", "код на весах", "артикул / код"] },
  { key: "price", label: "Цена продажи", synonyms: ["цена продажи", "цена", "розничная цена", "цена розничная", "цена реализации", "price", "розница", "narx"] },
  { key: "costPrice", label: "Себестоимость", synonyms: ["себестоимость", "цена закупки", "закупочная цена", "цена поставки", "закупка", "цена прихода", "cost"] },
  { key: "stock", label: "Остаток", synonyms: ["остаток", "количество", "кол-во", "кол", "остаток на складе", "stock", "qty", "qoldiq"] },
  { key: "unit", label: "Ед. измерения", synonyms: ["ед. изм.", "ед.изм.", "ед изм", "единица", "единица измерения", "ед", "unit"] },
  { key: "category", label: "Категория", synonyms: ["категория", "группа", "группа товаров", "папка", "category", "родитель"] },
  { key: "minStock", label: "Мин. остаток", synonyms: ["мин. остаток", "минимальный остаток", "мин остаток", "min stock"] },
];

export type Cell = string | number | boolean | Date | null;
export interface Table {
  sheet: string;
  rows: Cell[][];
}

/** Название колонки для сравнения: без регистра, «ё», точек, дефисов и лишних пробелов. */
export const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[.\s/_-]+/g, " ").trim();

/**
 * Какая колонка файла что значит — по названиям колонок. null — не нашлась.
 * fields — поля мастера со своими синонимами (у прихода «Количество» сильнее
 * «Остатка»); поле не из fields — всегда null.
 */
export function autoMap(headers: Cell[], fields: FieldDef[] = FIELDS): Record<FieldKey, number | null> {
  const titles = headers.map((h) => norm(String(h ?? "")));
  const used = new Set<number>();
  const result = Object.fromEntries(FIELDS.map((f) => [f.key, null])) as Record<FieldKey, number | null>;
  const synonyms = new Map(fields.map((f) => [f.key, f.synonyms.map(norm)]));
  // Сначала точные совпадения у всех полей, потом «начинается с» («Цена продажи, сўм»).
  // По одному полю за раз «цена» у цены продажи забирала колонку «Цена закупки»
  // раньше, чем до неё доходила себестоимость, — в приходе цена закупки
  // попадала в цену продажи.
  // Точное — по порядку синонимов, а не колонок: первый синоним самый точный.
  // Иначе в выгрузке товаров с дописанной справа «Количество» количеством
  // прихода становился «Остаток», стоящий левее, — текущий остаток склада.
  for (const field of fields) {
    for (const synonym of synonyms.get(field.key)!) {
      const index = titles.findIndex((t, i) => !used.has(i) && t === synonym);
      if (index < 0) continue;
      result[field.key] = index;
      used.add(index);
      break;
    }
  }
  // Из «начинается с» выигрывает самое длинное совпадение: «Цена закупки, сўм»
  // — себестоимость («цена закупки»), а не цена продажи («цена»).
  const candidates: { key: FieldKey; index: number; length: number }[] = [];
  for (const field of fields) {
    if (result[field.key] !== null) continue;
    titles.forEach((t, index) => {
      if (used.has(index) || t === "") return;
      const length = Math.max(0, ...synonyms.get(field.key)!.filter((s) => t.startsWith(s)).map((s) => s.length));
      if (length > 0) candidates.push({ key: field.key, index, length });
    });
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    if (result[c.key] !== null || used.has(c.index)) continue;
    result[c.key] = c.index;
    used.add(c.index);
  }
  return result;
}

/**
 * Колонка — одному полю: выбранная для поля, она снимается с остальных. Иначе
 * «Цена» накладной могла стать и ценой продажи, и себестоимостью сразу — и
 * приход ставил цену продажи, равную закупке.
 */
export function assignColumn(mapping: Record<FieldKey, number | null>, key: FieldKey, column: number | null): Record<FieldKey, number | null> {
  const next = { ...mapping };
  if (column !== null) for (const k of Object.keys(next) as FieldKey[]) if (next[k] === column) next[k] = null;
  next[key] = column;
  return next;
}

/** Строка заголовков: в выгрузках 1С над таблицей бывают строки с названием отчёта и датой. */
export function findHeaderRow(rows: Cell[][]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const mapped = Object.values(autoMap(rows[i])).filter((v) => v !== null).length;
    if (mapped > bestScore) {
      best = i;
      bestScore = mapped;
    }
  }
  return best;
}

/** CSV: разделитель «;» (1С, русский Excel), «,» или табуляция; кавычки по правилам CSV. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", "\t", ","].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Байты CSV в текст: UTF-8, а если он не сходится — Windows-1251 (так сохраняют 1С и старый Excel). */
export function decodeCsv(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  return utf8.includes("\uFFFD") ? new TextDecoder("windows-1251").decode(bytes) : utf8;
}

export async function readTables(file: File): Promise<Table[]> {
  if (/\.(csv|txt)$/i.test(file.name)) return [{ sheet: file.name, rows: parseCsv(decodeCsv(await file.arrayBuffer())) }];
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const sheets = await readXlsxFile(file);
  return sheets.map((s) => ({ sheet: s.sheet, rows: s.data as Cell[][] }));
}

/** Штрихкод/артикул из ячейки: Excel хранит длинные числа как число — без «4.78E+12». */
function codeText(value: Cell): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value.toFixed(0) : String(value);
  return String(value).trim() || undefined;
}

function cellValue(value: Cell): string | number | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

export interface ImportRow {
  row: number;
  name?: string | number;
  barcode?: string;
  sku?: string;
  price?: string | number;
  costPrice?: string | number;
  stock?: string | number;
  unit?: string | number;
  category?: string | number;
  minStock?: string | number;
}

/** Строки таблицы ниже заголовков → строки импорта по нашим полям. Номер — как в Excel (с 1). */
export function toImportRows(rows: Cell[][], headerRow: number, mapping: Record<FieldKey, number | null>): ImportRow[] {
  const result: ImportRow[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    if (cells.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
    const pick = (key: FieldKey) => (mapping[key] === null ? undefined : cells[mapping[key]!]);
    result.push({
      row: i + 1,
      name: cellValue(pick("name") ?? null),
      barcode: codeText(pick("barcode") ?? null),
      sku: codeText(pick("sku") ?? null),
      price: cellValue(pick("price") ?? null),
      costPrice: cellValue(pick("costPrice") ?? null),
      stock: cellValue(pick("stock") ?? null),
      unit: cellValue(pick("unit") ?? null),
      category: cellValue(pick("category") ?? null),
      minStock: cellValue(pick("minStock") ?? null),
    });
  }
  return result;
}

// ── выгрузка ────────────────────────────────────────────────────────────────

export interface ExportProduct {
  name: string;
  barcode: string | null;
  sku: string | null;
  category: string | null;
  unit: string;
  price: number;
  costPrice: number;
  stock: number | null;
  minStock: number;
  ikpu: string | null;
}

const EXPORT_COLUMNS: { title: string; width: number; get: (p: ExportProduct) => string | number | null }[] = [
  { title: "Название", width: 40, get: (p) => p.name },
  { title: "Штрихкод", width: 16, get: (p) => p.barcode },
  { title: "Артикул", width: 12, get: (p) => p.sku },
  { title: "Категория", width: 18, get: (p) => p.category },
  { title: "Ед. изм.", width: 8, get: (p) => p.unit },
  { title: "Цена продажи", width: 14, get: (p) => p.price },
  { title: "Себестоимость", width: 14, get: (p) => p.costPrice },
  { title: "Остаток", width: 10, get: (p) => p.stock },
  { title: "Мин. остаток", width: 12, get: (p) => p.minStock },
  { title: "ИКПУ", width: 20, get: (p) => p.ikpu },
];

const TEMPLATE_EXAMPLE: ExportProduct = {
  name: "Сок яблочный 1 л",
  barcode: "4780069000123",
  sku: "SOK-1",
  category: "Напитки",
  unit: "шт",
  price: 14000,
  costPrice: 11000,
  stock: 24,
  minStock: 5,
  ikpu: null,
};

export async function downloadXlsx(products: ExportProduct[], fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const header = EXPORT_COLUMNS.map((c) => ({ value: c.title, fontWeight: "bold" as const }));
  // Штрихкод — текстом: числом Excel покажет «4,78E+12» и съест ведущий ноль.
  const body = products.map((p) => EXPORT_COLUMNS.map((c) => ({ value: c.get(p) ?? undefined })));
  await writeXlsxFile([header, ...body], { sheet: "Товары", columns: EXPORT_COLUMNS.map((c) => ({ width: c.width })) }).toFile(fileName);
}

/** CSV для 1С и других программ: «;», UTF-8 с BOM — русский Excel открывает без кракозябр. */
export function productsCsv(products: ExportProduct[]): string {
  const esc = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "number" ? String(v).replace(".", ",") : v;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [EXPORT_COLUMNS.map((c) => c.title).join(";"), ...products.map((p) => EXPORT_COLUMNS.map((c) => esc(c.get(p))).join(";"))];
  return "\uFEFF" + lines.join("\r\n");
}

export function downloadCsv(products: ExportProduct[], fileName: string): void {
  const url = URL.createObjectURL(new Blob([productsCsv(products)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTemplate(): Promise<void> {
  return downloadXlsx([TEMPLATE_EXAMPLE], "Шаблон импорта товаров.xlsx");
}

/**
 * Строки как были в файле + колонка «Ошибка»: исправить и загрузить снова.
 * Импорт товаров отдаёт только строки с ошибками (остальные уже загружены),
 * приход — весь файл: он проводится только целиком, а помечены в нём и
 * новые товары (колонка «Проверка») — вдруг это опечатка в названии.
 */
export async function downloadErrorRows(
  headers: Cell[],
  rows: { cells: Cell[]; message: string }[],
  fileName: string,
  sheet = "Ошибки",
  column = "Ошибка"
): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const plain = (v: Cell) => (v === null || v === undefined ? undefined : typeof v === "number" ? v : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const width = Math.max(headers.length, ...rows.map((r) => r.cells.length));
  const pad = (cells: Cell[]) => Array.from({ length: width }, (_, i) => ({ value: plain(cells[i] ?? null) }));
  const header = [...pad(headers).map((c) => ({ ...c, fontWeight: "bold" as const })), { value: column, fontWeight: "bold" as const }];
  const body = rows.map((r) => [...pad(r.cells), { value: r.message }]);
  await writeXlsxFile([header, ...body], { sheet }).toFile(fileName);
}
