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

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[.\s/_-]+/g, " ").trim();

/** Какая колонка файла что значит — по названиям колонок. null — не нашлась. */
export function autoMap(headers: Cell[]): Record<FieldKey, number | null> {
  const titles = headers.map((h) => norm(String(h ?? "")));
  const used = new Set<number>();
  const result = {} as Record<FieldKey, number | null>;
  for (const field of FIELDS) {
    const synonyms = field.synonyms.map(norm);
    // Сначала точное совпадение, потом «начинается с» («Цена продажи, сўм»).
    let index = titles.findIndex((t, i) => !used.has(i) && synonyms.includes(t));
    if (index < 0) index = titles.findIndex((t, i) => !used.has(i) && t !== "" && synonyms.some((s) => t.startsWith(s)));
    result[field.key] = index >= 0 ? index : null;
    if (index >= 0) used.add(index);
  }
  return result;
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
  active: boolean;
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
  { title: "Активен", width: 9, get: (p) => (p.active ? "да" : "нет") },
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
  active: true,
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

/** Строки с ошибками как были в файле + колонка «Ошибка»: исправить и загрузить снова. */
export async function downloadErrorRows(headers: Cell[], rows: { cells: Cell[]; message: string }[], fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const plain = (v: Cell) => (v === null || v === undefined ? undefined : typeof v === "number" ? v : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const width = Math.max(headers.length, ...rows.map((r) => r.cells.length));
  const pad = (cells: Cell[]) => Array.from({ length: width }, (_, i) => ({ value: plain(cells[i] ?? null) }));
  const header = [...pad(headers).map((c) => ({ ...c, fontWeight: "bold" as const })), { value: "Ошибка", fontWeight: "bold" as const }];
  const body = rows.map((r) => [...pad(r.cells), { value: r.message }]);
  await writeXlsxFile([header, ...body], { sheet: "Ошибки" }).toFile(fileName);
}
