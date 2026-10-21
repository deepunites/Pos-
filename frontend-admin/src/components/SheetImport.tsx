import { useId, useState } from "react";
import { ArrowLeft, FileSpreadsheet, Upload } from "lucide-react";
import Button from "./Button";
import type { SheetFile } from "../hooks/useSheetFile";
import { assignColumn, type Cell, type FieldDef, type FieldKey } from "../utils/productsFile";

// Общие шаги мастеров загрузки из Excel/CSV — импорта товаров и прихода из
// файла: выбор файла и «какая колонка что значит». Мастера различаются
// подсказками и набором полей, а читать файл и подбирать колонки должны
// одинаково — иначе файл, который понял один, не поймёт другой.

/** Номер колонки → буква как в Excel: 0 → A, 26 → AA. */
function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const cellText = (v: Cell) => (v === null || v === undefined ? "" : v instanceof Date ? v.toLocaleDateString("ru-RU") : String(v).trim());

export function FileDropZone({ reading, onFile, hint }: { reading: boolean; onFile: (file: File | undefined) => void; hint: string }) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFile(e.dataTransfer.files[0]);
      }}
      className={`flex cursor-pointer flex-col items-center gap-3 rounded-md border-2 border-dashed px-6 py-10 text-center ${dragging ? "border-primary-500 bg-primary-50" : "border-gray-300 hover:border-gray-400"}`}
    >
      {reading ? (
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" aria-hidden />
      ) : (
        <Upload className="h-8 w-8 text-gray-400" aria-hidden />
      )}
      <span className="font-medium text-gray-900">{reading ? "Читаем файл…" : "Выберите файл или перетащите сюда"}</span>
      <span className="text-sm text-gray-500">{hint}</span>
      {/* .xls в списке, чтобы файл было видно в окне выбора: прочитать его
          нельзя, но лучше сказать, как пересохранить, чем молча его спрятать. */}
      <input
        id={inputId}
        type="file"
        accept=".xlsx,.xls,.csv,.txt"
        className="sr-only"
        disabled={reading}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

interface ColumnMappingProps {
  file: SheetFile;
  fields: FieldDef[];
  /** Без этих колонок дальше не пройти — помечаются «обязательно». */
  required?: FieldKey[];
  hint: string;
  onOtherFile: () => void;
}

/** Лист, строка заголовков и колонка для каждого поля. Кнопки «дальше» — у мастера. */
export function ColumnMapping({ file, fields, required = [], hint, onOtherFile }: ColumnMappingProps) {
  const id = useId();
  const { rows, headers, headerRow, mapping, width, tables, sheet } = file;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-md bg-gray-50 px-3 py-2.5 text-sm">
        <FileSpreadsheet className="h-5 w-5 flex-shrink-0 text-gray-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <b className="font-medium text-gray-900">{file.fileName}</b>
          <span className="text-gray-500"> · {file.importRows.length.toLocaleString("ru-RU")} строк</span>
        </div>
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onOtherFile}>
          Другой файл
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        {tables.length > 1 && (
          <label className="flex items-center gap-2 text-gray-600">
            Лист
            <select className="input w-auto py-1.5" value={sheet} onChange={(e) => file.pickSheet(Number(e.target.value))}>
              {tables.map((t, i) => (
                <option key={t.sheet + i} value={i}>
                  {t.sheet}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-gray-600">
          Заголовки в строке
          <select className="input w-auto py-1.5" value={headerRow} onChange={(e) => file.pickHeaderRow(Number(e.target.value))}>
            {rows.slice(0, 15).map((_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <p className="text-sm font-semibold text-gray-700">Какая колонка файла что значит</p>
        <p className="text-xs text-gray-500">{hint}</p>
      </div>

      <div className="divide-y divide-gray-100">
        {fields.map((field) => {
          const column = mapping[field.key];
          const samples =
            column === null
              ? ""
              : rows
                  .slice(headerRow + 1)
                  .map((r) => cellText(r[column] ?? null))
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(" · ");
          return (
            <div key={field.key} className="grid grid-cols-1 gap-1 py-2 md:grid-cols-[10rem_1.25rem_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-3">
              <label htmlFor={`${id}-${field.key}`} className="text-sm font-medium text-gray-900">
                {field.label}
                {required.includes(field.key) && <span className="block text-xs font-normal text-gray-500">обязательно</span>}
              </label>
              <ArrowLeft className="hidden h-4 w-4 text-gray-400 md:block" aria-hidden />
              <select
                id={`${id}-${field.key}`}
                className={`input py-1.5 text-sm ${column === null ? "text-gray-500" : ""}`}
                value={column ?? ""}
                onChange={(e) => file.setMapping(assignColumn(mapping, field.key, e.target.value === "" ? null : Number(e.target.value)))}
              >
                <option value="">— не загружать —</option>
                {Array.from({ length: width }, (_, i) => (
                  <option key={i} value={i}>
                    {cellText(headers[i] ?? null) || `Колонка ${columnLetter(i)}`}
                  </option>
                ))}
              </select>
              <span className="truncate text-xs text-gray-500 tabular-nums">{samples}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
