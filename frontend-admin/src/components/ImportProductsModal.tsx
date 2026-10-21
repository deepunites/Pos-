import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Download } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import Badge from "./Badge";
import { notify } from "./notify";
import { ColumnMapping, FileDropZone } from "./SheetImport";
import { useSheetFile } from "../hooks/useSheetFile";
import { productService, type ImportChange, type ImportItem, type ImportResult } from "../services";
import { apiErrorMessage } from "../utils/apiError";
import { FIELDS, downloadErrorRows, downloadTemplate, type ImportRow } from "../utils/productsFile";

// Импорт товаров: файл → какая колонка что значит → проверка → загрузка.
// Проверка — тот же запрос, что и загрузка, но с apply=false: ничего не пишет.

const MAX_ROWS = 10_000;

type Step = "file" | "map" | "check" | "done";

const FIELD_NAMES: Record<ImportChange["field"], string> = {
  name: "название",
  barcode: "штрихкод",
  sku: "артикул",
  category: "категория",
  unit: "ед.",
  price: "цена",
  costPrice: "себестоимость",
  stock: "остаток",
  minStock: "мин. остаток",
  active: "продажа",
};

const num = (v: string | number | null) => (v === null ? "—" : typeof v === "number" ? v.toLocaleString("ru-RU", { maximumFractionDigits: 3 }) : v);

function describe(item: ImportItem, sent: ImportRow | undefined): string {
  if (item.kind === "error") return item.message ?? "ошибка";
  if (item.kind === "same") return "без изменений";
  if (item.kind === "update") {
    return item.changes
      .map((c) =>
        c.field === "active"
          ? "вернётся в продажу"
          : c.from === null || c.from === ""
          ? `${FIELD_NAMES[c.field]} ${num(c.to)}${c.field === "stock" ? " (начнём считать)" : ""}`
          : `${FIELD_NAMES[c.field]} ${num(c.from)} → ${num(c.to)}`
      )
      .join(" · ");
  }
  if (!sent) return "";
  const weighed = /^(кг|kg|килограмм)/i.test(String(sent.unit ?? "").trim());
  const raw = (v: string | number) => (typeof v === "number" ? num(v) : v);
  return [weighed && "на вес", sent.price !== undefined && `цена ${raw(sent.price)}`, sent.stock !== undefined && `остаток ${raw(sent.stock)}`, sent.category && String(sent.category)]
    .filter(Boolean)
    .join(" · ");
}

const KIND: Record<ImportItem["kind"], { label: string; variant: "success" | "warning" | "danger" | "gray" }> = {
  create: { label: "новый", variant: "success" },
  update: { label: "обновится", variant: "warning" },
  same: { label: "как есть", variant: "gray" },
  error: { label: "ошибка", variant: "danger" },
};

export default function ImportProductsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const file = useSheetFile();
  const { fileName, rows, headers, mapping, importRows } = file;
  const [step, setStep] = useState<Step>("file");
  const [result, setResult] = useState<ImportResult | null>(null);

  const sentByRow = useMemo(() => new Map(importRows.map((r) => [r.row, r])), [importRows]);

  const check = useMutation({
    mutationFn: () => productService.importRows(importRows, false),
    onSuccess: (res) => {
      setResult(res.data.data);
      setStep("check");
    },
    onError: (e) => notify.error(apiErrorMessage(e, "Не удалось проверить файл")),
  });

  const apply = useMutation({
    mutationFn: () => productService.importRows(importRows, true),
    onSuccess: (res) => {
      const done = res.data.data;
      setResult(done);
      setStep("done");
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      notify.success(`Загружено: новых ${done.summary.create}, обновлено ${done.summary.update}`);
    },
    onError: (e) => notify.error(apiErrorMessage(e, "Не удалось загрузить товары")),
  });

  const openFile = async (picked: File | undefined) => {
    if (await file.openFile(picked)) setStep("map");
  };

  const keyMapped = mapping.name !== null || mapping.barcode !== null || mapping.sku !== null;
  const tooMany = importRows.length > MAX_ROWS;
  const toLoad = result ? result.summary.create + result.summary.update : 0;
  const totalChecked = result ? result.summary.create + result.summary.update + result.summary.same + result.summary.error : 0;

  const downloadErrors = () => {
    if (!result) return;
    const errors = result.items.filter((i) => i.kind === "error");
    const base = fileName.replace(/\.[^.]+$/, "");
    downloadErrorRows(
      headers,
      errors.map((e) => ({ cells: rows[e.row - 1] ?? [], message: e.message ?? "" })),
      `${base} — ошибки.xlsx`
    ).catch(() => notify.error("Не удалось сохранить файл"));
  };

  const title =
    step === "file" ? "Импорт товаров · шаг 1 из 3" : step === "map" ? "Импорт товаров · шаг 2 из 3" : step === "check" ? "Импорт товаров · шаг 3 из 3 — проверка" : "Импорт товаров — готово";

  return (
    <Modal isOpen onClose={onClose} title={title} size="xl">
      {step === "file" && (
        <div className="space-y-4">
          <FileDropZone reading={file.reading} onFile={(f) => void openFile(f)} hint="Excel (.xlsx) или CSV — выгрузка из 1С, другой программы или наш шаблон" />
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
            <span>Товар ищется по штрихкоду, потом по артикулу. Нашёлся — обновится, нет — добавится.</span>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => void downloadTemplate()}>
              Шаблон
            </Button>
          </div>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <ColumnMapping
            file={file}
            fields={FIELDS}
            hint="Подобрано по названиям колонок — проверьте. «Не загружать» — поле товара не меняется."
            onOtherFile={() => setStep("file")}
          />

          {!keyMapped && <p className="text-sm text-danger-600">Укажите колонку с названием, штрихкодом или артикулом.</p>}
          {keyMapped && mapping.barcode === null && mapping.sku === null && (
            <p className="text-sm text-warning-800">Нет колонки штрихкода и артикула — товары искать не по чему, все строки добавятся как новые.</p>
          )}
          {tooMany && <p className="text-sm text-danger-600">В файле больше {MAX_ROWS.toLocaleString("ru-RU")} строк — разделите его на части.</p>}

          {/* Кнопки видны всегда: список колонок длиннее окна на ноутбуке. */}
          <div className="sticky -bottom-4 -mx-6 -mb-4 border-t border-gray-100 bg-surface px-6 py-3 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setStep("file")}>
              Назад
            </Button>
            <Button disabled={!keyMapped || tooMany || importRows.length === 0} loading={check.isPending} onClick={() => check.mutate()}>
              Проверить
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {(step === "check" || step === "done") && result && (
        <div className="space-y-4">
          {step === "done" && (
            <div className="flex items-center gap-3 rounded-md bg-success-50 px-4 py-3 text-success-700">
              <Check className="h-5 w-5 flex-shrink-0" aria-hidden />
              <span className="font-medium">Товары загружены. Остатки встали как в файле, разница записана в движения склада.</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="card p-3">
              <p className="text-xs text-gray-500">{step === "done" ? "Добавлено" : "Новых товаров"}</p>
              <p className="text-2xl font-bold text-success-700">{result.summary.create.toLocaleString("ru-RU")}</p>
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">{step === "done" ? "Обновлено" : "Обновится"}</p>
              <p className="text-2xl font-bold text-info-700">{result.summary.update.toLocaleString("ru-RU")}</p>
              {(result.summary.priceChanged > 0 || result.summary.stockChanged > 0) && (
                <p className="text-xs text-gray-500">
                  цена у {result.summary.priceChanged}, остаток у {result.summary.stockChanged}
                </p>
              )}
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">Без изменений</p>
              <p className="text-2xl font-bold text-gray-900">{result.summary.same.toLocaleString("ru-RU")}</p>
            </div>
            <div className={`card p-3 ${result.summary.error ? "border-danger-200" : ""}`}>
              <p className="text-xs text-gray-500">{step === "done" ? "Пропущено с ошибками" : "Ошибки — пропустим"}</p>
              <p className={`text-2xl font-bold ${result.summary.error ? "text-danger-600" : "text-gray-900"}`}>{result.summary.error.toLocaleString("ru-RU")}</p>
            </div>
          </div>

          {step === "check" && result.items.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-md border border-gray-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Строка</th>
                    <th className="px-3 py-2 font-medium">Товар</th>
                    <th className="px-3 py-2 font-medium">Что будет</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {result.items.map((item) => (
                    <tr key={item.row}>
                      <td className="px-3 py-2 text-gray-500 tabular-nums">{item.row}</td>
                      <td className="px-3 py-2 text-gray-900">{item.name || "—"}</td>
                      <td className="px-3 py-2">
                        <Badge variant={KIND[item.kind].variant}>{KIND[item.kind].label}</Badge>{" "}
                        <span className="text-gray-600 tabular-nums">{describe(item, sentByRow.get(item.row))}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.items.length < totalChecked && (
                <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
                  Показаны первые {result.items.length} из {totalChecked.toLocaleString("ru-RU")} строк — сначала ошибки, потом изменения.
                </p>
              )}
            </div>
          )}

          {step === "check" && (
            <p className="text-xs text-gray-500">
              Остатки встанут как в файле; разница запишется в движения склада с пометкой «Импорт». Пустая ячейка — поле товара не меняется.
            </p>
          )}

          <div className="sticky -bottom-4 -mx-6 -mb-4 border-t border-gray-100 bg-surface px-6 py-3 flex flex-wrap items-center justify-between gap-3">
            {result.summary.error > 0 ? (
              <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={downloadErrors}>
                Скачать ошибки
              </Button>
            ) : (
              <span />
            )}
            {step === "check" ? (
              <div className="flex gap-3">
                <Button variant="secondary" disabled={apply.isPending} onClick={() => setStep("map")}>
                  Назад
                </Button>
                <Button disabled={toLoad === 0} loading={apply.isPending} icon={<Check className="h-4 w-4" />} onClick={() => apply.mutate()}>
                  {toLoad === 0 ? "Нечего загружать" : `Загрузить ${toLoad.toLocaleString("ru-RU")} ${plural(toLoad, "товар", "товара", "товаров")}`}
                </Button>
              </div>
            ) : (
              <Button onClick={onClose}>Закрыть</Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
