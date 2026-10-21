import { useMemo, useState } from "react";
import { notify } from "../components/notify";
import { autoMap, findHeaderRow, readTables, toImportRows, type Cell, type FieldKey, type Table } from "../utils/productsFile";

export type Mapping = Record<FieldKey, number | null>;

/**
 * Файл Excel/CSV в мастере загрузки: листы, строка заголовков и какая колонка
 * что значит. Общий для импорта товаров и прихода из файла — оба мастера
 * читают файл одинаково и шлют серверу одни и те же строки (toImportRows).
 *
 * keys — поля, которые мастер загружает; остальные не подбираются и в запрос не
 * попадают (приходу мин. остаток ни к чему). map — как мастер подбирает колонки
 * по заголовкам: у прихода «Количество» сильнее «Остатка», а голая «Цена» без
 * колонки закупки — себестоимость.
 */
export function useSheetFile(keys?: readonly FieldKey[], map: (headers: Cell[]) => Mapping = (headers) => autoMap(headers)) {
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [tables, setTables] = useState<Table[]>([]);
  const [sheet, setSheet] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Mapping>(() => autoMap([]));

  const rows = useMemo(() => tables[sheet]?.rows ?? [], [tables, sheet]);
  const headers = rows[headerRow] ?? [];
  const width = Math.max(headers.length, ...rows.slice(headerRow + 1, headerRow + 50).map((r) => r.length), 0);
  const importRows = useMemo(() => toImportRows(rows, headerRow, mapping), [rows, headerRow, mapping]);

  const mapHeaders = (cells: Cell[]): Mapping => {
    const m = map(cells);
    if (keys) for (const k of Object.keys(m) as FieldKey[]) if (!keys.includes(k)) m[k] = null;
    return m;
  };

  const pickSheet = (index: number, all: Table[] = tables) => {
    const header = findHeaderRow(all[index]?.rows ?? []);
    setSheet(index);
    setHeaderRow(header);
    setMapping(mapHeaders(all[index]?.rows[header] ?? []));
  };

  const pickHeaderRow = (index: number) => {
    setHeaderRow(index);
    setMapping(mapHeaders(rows[index] ?? []));
  };

  /** true — файл прочитан и в нём есть строки; иначе пользователь уже увидел, что не так. */
  const openFile = async (file: File | undefined): Promise<boolean> => {
    if (!file) return false;
    if (/\.xls$/i.test(file.name)) {
      notify.error("Старый формат .xls не читается — откройте файл в Excel и сохраните как .xlsx");
      return false;
    }
    setReading(true);
    try {
      const read = await readTables(file);
      const index = Math.max(0, read.findIndex((t) => t.rows.length > 1));
      if (!read[index] || read[index].rows.length < 2) {
        notify.error("В файле нет строк с товарами");
        return false;
      }
      setFileName(file.name);
      setTables(read);
      pickSheet(index, read);
      return true;
    } catch {
      notify.error("Не удалось прочитать файл. Нужен Excel (.xlsx) или CSV");
      return false;
    } finally {
      setReading(false);
    }
  };

  return { fileName, reading, tables, sheet, headerRow, mapping, setMapping, rows, headers, width, importRows, pickSheet, pickHeaderRow, openFile };
}

export type SheetFile = ReturnType<typeof useSheetFile>;
