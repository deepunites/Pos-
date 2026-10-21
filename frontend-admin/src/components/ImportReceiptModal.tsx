import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Download, Upload } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import Badge from "./Badge";
import Tabs, { type TabItem } from "./Tabs";
import { notify } from "./notify";
import { ColumnMapping, FileDropZone } from "./SheetImport";
import { useSheetFile } from "../hooks/useSheetFile";
import { useMoney } from "../hooks/useMoney";
import { stockReceiptService, type ReceiptImportItem, type ReceiptImportResult } from "../services";
import { apiErrorMessage } from "../utils/apiError";
import { downloadErrorRows, type ImportRow } from "../utils/productsFile";
import {
  DUPLICATE_DAYS,
  ITEM_KIND,
  MAX_RECEIPT_ROWS,
  RECEIPT_FIELDS,
  RECEIPT_KEYS,
  RECEIPT_REQUIRED,
  applyErrorMessage,
  canApply,
  fileNote,
  findDuplicateReceipt,
  mappingProblems,
  priceView,
  receiptAutoMap,
  rowMarks,
  shouldRecheck,
  type ItemFilter,
  type RecentReceipt,
} from "../utils/receiptImport";

// Приход из Excel: файл → какая колонка что значит → проверка → приход.
// Проверка — тот же запрос с apply=false: сервер находит товары, считает суммы
// и ничего не пишет. Проводится один приход на весь файл и только без ошибок —
// строку с ошибкой исправляют в файле и загружают его снова.

type Step = "file" | "map" | "check" | "done";

const qty = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: 3 }));

// Каким новый товар заведётся: категория, единица, штрихкод — как в файле.
function newProductNote(sent: ImportRow | undefined): string {
  if (!sent) return "";
  return [sent.category, sent.unit, sent.barcode, sent.sku].filter((v) => v !== undefined && String(v).trim() !== "").join(" · ");
}

const when = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const doneTitle = (r: ReceiptImportResult) => (r.receipt?.receiptNumber ? `Приход №${r.receipt.receiptNumber} проведён` : "Приход проведён");

const QUERIES = ["stock-receipts", "inventory", "inventory-alerts", "products", "products-all", "categories", "last-supply"];

export default function ImportReceiptModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { money } = useMoney();
  const fieldId = useId();
  const file = useSheetFile(RECEIPT_KEYS, receiptAutoMap);
  const { fileName, rows, headers, mapping, importRows } = file;
  const [step, setStep] = useState<Step>("file");
  const [result, setResult] = useState<ReceiptImportResult | null>(null);
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [supplierName, setSupplierName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  // Один ключ на окно: двойной клик или повтор после обрыва связи не проведут
  // приход дважды. Поэтому, пока приход проводится, окно не закрывается (Modal
  // closable): закрыл и загрузил файл снова — новый ключ и второй приход.
  const [idempotencyKey] = useState(() => `admin-receipt-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  // Владелец подтвердил: похожий недавний приход — другая поставка.
  const [confirmedNew, setConfirmedNew] = useState(false);

  // Номер, который сервер даст приходу сам, — подсказкой в поле накладной.
  const { data: autoNumber } = useQuery({
    queryKey: ["stock-receipts", "next-number"],
    queryFn: () => stockReceiptService.nextNumber().then((r) => r.data.data.invoiceNumber),
  });

  // Недавние приходы — узнать файл, который уже провели: владелец исправил
  // название и загрузил весь файл ещё раз, а ключ повтора от прошлого окна не
  // сохранился.
  const { data: recent = [] } = useQuery({
    queryKey: ["stock-receipts", "recent-for-import"],
    queryFn: () =>
      stockReceiptService
        .list({ dateFrom: new Date(Date.now() - DUPLICATE_DAYS * 24 * 3600 * 1000).toISOString(), limit: 100 })
        .then((r) => (r.data.data ?? []) as RecentReceipt[]),
    staleTime: 0,
  });

  const sentByRow = useMemo(() => new Map(importRows.map((r) => [r.row, r])), [importRows]);
  const problems = mappingProblems(mapping);
  const tooMany = importRows.length > MAX_RECEIPT_ROWS;

  const check = useMutation({
    mutationFn: () => stockReceiptService.importRows({ rows: importRows, apply: false }),
    onSuccess: (res) => {
      setResult(res.data.data);
      setFilter("all");
      setConfirmedNew(false);
      setStep("check");
    },
    onError: (e) => notify.error(apiErrorMessage(e, "Не удалось проверить файл")),
  });

  const apply = useMutation({
    mutationFn: () =>
      stockReceiptService.importRows(
        {
          rows: importRows,
          apply: true,
          supplierName: supplierName.trim() || undefined,
          // Пусто — сервер даст следующий номер по порядку («ПР-0043»).
          invoiceNumber: invoiceNumber.trim() || undefined,
          notes: fileNote(fileName),
        },
        idempotencyKey
      ),
    onSuccess: (res) => {
      const done = res.data.data;
      setResult(done);
      setStep("done");
      for (const key of QUERIES) qc.invalidateQueries({ queryKey: [key] });
      notify.success(doneTitle(done));
    },
    onError: (e) => {
      notify.error(applyErrorMessage(e));
      // Ответ не дошёл, а приход мог записаться: свежий список приходов — и
      // проверка того же файла предупредит, что он уже проведён.
      qc.invalidateQueries({ queryKey: ["stock-receipts", "recent-for-import"] });
      // Файл перестал проходить проверку уже после неё — иначе таблица так и
      // показывала бы «0 ошибок», а «Провести» каждый раз отвечал бы тем же.
      if (shouldRecheck(e)) check.mutate();
    },
  });

  const openFile = async (picked: File | undefined) => {
    if (!(await file.openFile(picked))) return;
    setResult(null);
    setStep("map");
  };

  // Весь файл, в колонке «Проверка» — причина у ошибок и пометка у новых
  // товаров: приход проводится только целиком, поэтому исправленный файл
  // загружают полностью.
  const downloadMarked = () => {
    if (!result) return;
    const marks = rowMarks(result.items);
    downloadErrorRows(
      headers,
      importRows.map((r) => ({ cells: rows[r.row - 1] ?? [], message: marks.get(r.row) ?? "" })),
      `${fileName.replace(/\.[^.]+$/, "")} — исправить.xlsx`,
      "Приход",
      "Проверка"
    ).catch(() => notify.error("Не удалось сохранить файл"));
  };

  const fixButtons = (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={downloadMarked}>
        Скачать файл с пометками
      </Button>
      <Button variant="secondary" icon={<Upload className="h-4 w-4" />} onClick={() => setStep("file")}>
        Загрузить исправленный
      </Button>
    </div>
  );

  const summary = result?.summary;
  const total = summary ? summary.existing + summary.new + summary.error : 0;
  const duplicate = result && step === "check" ? findDuplicateReceipt(result, fileName, recent) : null;
  const ready = summary ? canApply(summary) && (!duplicate || confirmedNew) : false;
  const visible = result ? (filter === "all" ? result.items : result.items.filter((i) => i.kind === filter)) : [];
  const tabs: TabItem<ItemFilter>[] = summary
    ? [
        { value: "all" as const, label: "Все", count: total },
        ...(summary.error ? [{ value: "error" as const, label: "Ошибки", count: summary.error }] : []),
        ...(summary.new ? [{ value: "new" as const, label: "Новые товары", count: summary.new }] : []),
        ...(summary.existing ? [{ value: "existing" as const, label: "Есть в базе", count: summary.existing }] : []),
      ]
    : [];

  const title =
    step === "file" ? "Приход из Excel · шаг 1 из 3" : step === "map" ? "Приход из Excel · шаг 2 из 3" : step === "check" ? "Приход из Excel · шаг 3 из 3 — проверка" : "Приход из Excel — готово";

  const price = (item: ReceiptImportItem) => {
    const view = priceView(item);
    switch (view.kind) {
      case "change":
        return (
          <span className="whitespace-nowrap text-warning-800" title="Цена продажи изменится">
            {money(view.from)} → <b className="font-semibold">{money(view.to)}</b>
          </span>
        );
      case "set":
        // Новый товар без цены в файле: сервер посчитал её по наценке категории.
        return item.kind === "new" && sentByRow.get(item.row)?.price === undefined ? (
          <span title="В файле нет цены продажи — посчитана по наценке категории">
            {money(view.to)}
            <span className="block text-xs text-gray-500">по наценке</span>
          </span>
        ) : (
          money(view.to)
        );
      case "keep":
        return (
          <span className="text-gray-500" title="Цена продажи не меняется">
            {money(view.current)}
          </span>
        );
      case "markup":
        return (
          <span className="text-gray-500" title="В файле нет цены продажи — посчитается по наценке категории">
            по наценке
          </span>
        );
      default:
        return "—";
    }
  };

  return (
    <Modal isOpen onClose={onClose} closable={!apply.isPending} title={title} size="xl">
      {step === "file" && (
        <div className="space-y-4">
          <FileDropZone
            reading={file.reading}
            onFile={(f) => void openFile(f)}
            hint="Excel (.xlsx) или CSV: название, количество, себестоимость; цена продажи, штрихкод и артикул — если есть"
          />
          <p className="text-sm text-gray-500">
            Один файл — один приход. Товар ищется по штрихкоду, потом по артикулу, а если их нет — по названию. Не нашёлся — заведётся новый товар.
          </p>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <ColumnMapping
            file={file}
            fields={RECEIPT_FIELDS}
            required={RECEIPT_REQUIRED}
            hint="Подобрано по названиям колонок — проверьте. Количество — сколько пришло (в файле может называться «Остаток»)."
            onOtherFile={() => setStep("file")}
          />

          {problems.map((p) => (
            <p key={p} className="text-sm text-danger-600">
              {p}
            </p>
          ))}
          {problems.length === 0 && mapping.barcode === null && mapping.sku === null && (
            <p className="text-sm text-warning-800">
              Нет колонки штрихкода и артикула — товары ищутся по названию. Название должно совпадать с карточкой товара, иначе заведётся новый.
            </p>
          )}
          {tooMany && <p className="text-sm text-danger-600">В файле больше {MAX_RECEIPT_ROWS.toLocaleString("ru-RU")} строк — разделите его на несколько приходов.</p>}

          {/* Кнопки видны всегда: список колонок длиннее окна на ноутбуке. */}
          <div className="sticky -bottom-4 -mx-6 -mb-4 border-t border-gray-100 bg-surface px-6 py-3 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setStep("file")}>
              Назад
            </Button>
            <Button disabled={problems.length > 0 || tooMany || importRows.length === 0} loading={check.isPending} onClick={() => check.mutate()}>
              Проверить
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {(step === "check" || step === "done") && result && summary && (
        <div className="space-y-4">
          {step === "done" && (
            <div className="flex items-center gap-3 rounded-md bg-success-50 px-4 py-3 text-success-700">
              <Check className="h-5 w-5 flex-shrink-0" aria-hidden />
              <span className="font-medium">
                {doneTitle(result)}
                {" — "}остатки выросли, себестоимость обновлена{summary.new > 0 ? `, новых товаров заведено: ${summary.new}` : ""}.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <div className="card p-3">
              <p className="text-xs text-gray-500">Есть в базе</p>
              <p className="text-2xl font-bold text-gray-900">{summary.existing.toLocaleString("ru-RU")}</p>
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">{step === "done" ? "Новых товаров заведено" : "Новые товары"}</p>
              <p className={`text-2xl font-bold ${summary.new ? "text-warning-800" : "text-gray-900"}`}>{summary.new.toLocaleString("ru-RU")}</p>
            </div>
            <div className={`card p-3 ${summary.error ? "border-danger-200" : ""}`}>
              <p className="text-xs text-gray-500">Ошибки</p>
              <p className={`text-2xl font-bold ${summary.error ? "text-danger-600" : "text-gray-900"}`}>{summary.error.toLocaleString("ru-RU")}</p>
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">Количество</p>
              <p className="text-xl font-bold text-gray-900 tabular-nums">{qty(summary.quantity)}</p>
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">Сумма закупки</p>
              <p className="text-xl font-bold text-gray-900 tabular-nums">{money(summary.totalCost)}</p>
            </div>
            <div className="card p-3">
              <p className="text-xs text-gray-500">В продаже на</p>
              <p className="text-xl font-bold text-gray-900 tabular-nums">{money(summary.totalSale)}</p>
            </div>
          </div>

          {step === "check" && duplicate && (
            <div className="space-y-2 rounded-md border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
              <p className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>
                  Похоже, этот файл уже проведён: приход{duplicate.invoiceNumber ? ` №${duplicate.invoiceNumber}` : ""} от {when(duplicate.createdAt)}. Второй
                  приход ещё раз прибавит остатки. Если в проведённом приходе ошибка — удалите его на странице «Приходы» и проведите файл заново.
                </span>
              </p>
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={confirmedNew} onChange={(e) => setConfirmedNew(e.target.checked)} disabled={apply.isPending} />
                Это новая поставка — провести ещё раз
              </label>
            </div>
          )}

          {step === "check" && summary.error > 0 && (
            <div className="space-y-3 rounded-md border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
              <p>
                В файле есть ошибки — приход проводится только целиком. Исправьте строки в файле и загрузите его снова. В скачанном файле — все строки, у
                ошибочных причина в колонке «Проверка».
              </p>
              {fixButtons}
            </div>
          )}

          {step === "check" && result.items.length > 0 && (
            <div>
              {tabs.length > 2 && <Tabs label="Какие строки показать" items={tabs} value={filter} onChange={setFilter} className="mb-2" />}
              <div className="max-h-80 overflow-auto rounded-md border border-gray-200">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Строка</th>
                      <th className="px-3 py-2 font-medium">Товар</th>
                      <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                      <th className="px-3 py-2 text-right font-medium">Себестоимость</th>
                      <th className="px-3 py-2 text-right font-medium">Цена продажи</th>
                      <th className="px-3 py-2 text-right font-medium">Сумма</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visible.map((item) => {
                      const note = item.kind === "new" ? newProductNote(sentByRow.get(item.row)) : "";
                      return (
                        <tr key={item.row} className="align-top">
                          <td className="px-3 py-2 text-gray-500 tabular-nums">{item.row}</td>
                          <td className="px-3 py-2">
                            <div className="text-gray-900">{item.name || "—"}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                              <Badge variant={ITEM_KIND[item.kind].variant}>{ITEM_KIND[item.kind].label}</Badge>
                              {item.kind === "error" && <span className="text-danger-700">{item.message ?? "ошибка"}</span>}
                              {/* «снят с продажи — вернётся в продажу»: владелец должен знать, что товар снова появится на кассе. */}
                              {item.kind !== "error" && item.message && <span className="text-warning-800">{item.message}</span>}
                              {note && <span className="text-gray-500">{note}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{qty(item.quantity)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{item.costPrice === undefined ? "—" : money(item.costPrice)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{price(item)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium">{item.sum === undefined ? "—" : money(item.sum)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {result.items.length < total && (
                  <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
                    Показаны первые {result.items.length} из {total.toLocaleString("ru-RU")} строк — сначала ошибки, потом по порядку.
                  </p>
                )}
              </div>
            </div>
          )}

          {step === "check" && summary.new > 0 && (
            <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
              <p>
                «Новый товар» — в базе нет товара с таким штрихкодом, артикулом или названием. Если это опечатка в названии, исправьте его в файле как в карточке
                товара и загрузите файл снова — иначе заведётся двойник.
                {summary.error === 0 && " В скачанном файле новые товары помечены в колонке «Проверка»."}
              </p>
              {/* С ошибками те же кнопки — в блоке ошибок выше. */}
              {summary.error === 0 && fixButtons}
            </div>
          )}

          {step === "check" && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${fieldId}-supplier`} className="label">
                  Поставщик
                </label>
                <input
                  id={`${fieldId}-supplier`}
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  disabled={apply.isPending}
                  className="input"
                  placeholder="Название поставщика"
                />
              </div>
              <div>
                <label htmlFor={`${fieldId}-invoice`} className="label">
                  № накладной
                </label>
                <input
                  id={`${fieldId}-invoice`}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  disabled={apply.isPending}
                  className="input"
                  placeholder={autoNumber || "Номер документа"}
                />
                <p className="mt-1 text-xs text-gray-500">Пусто — следующий по порядку{autoNumber ? `, ${autoNumber}` : ""}</p>
              </div>
            </div>
          )}

          <div className="sticky -bottom-4 -mx-6 -mb-4 border-t border-gray-100 bg-surface px-6 py-3 flex flex-wrap items-center justify-end gap-3">
            {step === "check" ? (
              <>
                {summary.error > 0 && <span className="mr-auto hidden text-sm text-danger-600 sm:inline">Сначала исправьте ошибки в файле</span>}
                {summary.error === 0 && duplicate && !confirmedNew && (
                  <span className="mr-auto hidden text-sm text-warning-800 sm:inline">Файл похож на уже проведённый — отметьте, что это новая поставка</span>
                )}
                <Button variant="secondary" disabled={apply.isPending} onClick={() => setStep("map")}>
                  Назад
                </Button>
                <Button
                  disabled={!ready}
                  loading={apply.isPending}
                  icon={<Check className="h-4 w-4" />}
                  onClick={() => apply.mutate()}
                >
                  {summary.existing + summary.new > 0 ? `Провести приход на ${money(summary.totalCost)}` : "Нечего проводить"}
                </Button>
              </>
            ) : (
              <Button onClick={onClose}>Закрыть</Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
