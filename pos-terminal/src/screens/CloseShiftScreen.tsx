import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Banknote, CreditCard, HandCoins, Lock, NotebookPen, QrCode, TrendingUp, Undo2, X } from "lucide-react";
import api from "../services/api";
import toast from "react-hot-toast";
import type { CashShift } from "../types";
import { useMoney } from "../hooks/useMoney";
import { apiErrorMessage } from "../utils/apiError";


interface CloseShiftScreenProps {
  shiftId: string;
  onShiftClosed: (shift: CashShift) => void;
  onCancel: () => void;
}

export default function CloseShiftScreen({ shiftId, onShiftClosed, onCancel }: CloseShiftScreenProps) {
  const { money, symbol } = useMoney();
  const [closingCash, setClosingCash] = useState("");
  const [notes, setNotes] = useState("");

  const { data: shift, isLoading } = useQuery<CashShift>({
    queryKey: ["cash-shift", shiftId],
    queryFn: () => api.get(`/cash-shifts/${shiftId}`).then((r) => r.data.data),
  });

  const closeShift = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/cash-shifts/${shiftId}/close`, {
        closingCash: parseFloat(closingCash) || 0,
        notes: notes || undefined,
      });
      return res.data.data as CashShift;
    },
    onSuccess: (closedShift) => {
      toast.success("Смена закрыта!");
      onShiftClosed(closedShift);
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, "Не удалось закрыть смену — повторите"));
    },
  });

  if (isLoading || !shift) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-dark-500 border-t-primary-500" />
      </div>
    );
  }

  // «Слепое» закрытие: кассир пересчитывает ящик, не зная, сколько должно
  // быть, — ни итогов, ни подсказок суммой, ни расхождения. Их видит администратор.
  const blind = shift.blind === true;

  // Ожидаемые наличные считает сервер: начальная сумма, наличные продажи и
  // погашения долгов наличными. Раньше касса считала сама и вычитала возвраты,
  // которые уже выпали из продаж, а погашений не знала вовсе.
  const expectedCash = shift.expectedCash ?? shift.openingCash + shift.totalCashSales;
  const debtSales = shift.totalDebtSales ?? 0;
  const repaidCash = shift.totalDebtRepaidCash ?? 0;
  const repaidCard = shift.totalDebtRepaidCard ?? 0;
  const returnsCash = shift.totalReturnsCash ?? 0;
  const returnsOther = (shift.totalReturnsCard ?? 0) + (shift.totalReturnsDebt ?? 0);
  const parsedClosing = parseFloat(closingCash) || 0;
  const difference = parsedClosing - expectedCash;
  const quickAmounts = [expectedCash, Math.round(expectedCash / 10000) * 10000, Math.ceil(expectedCash / 50000) * 50000];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" style={{ animation: "fade-in 0.2s ease" }}>
      <div
        className="relative mx-4 w-full max-w-lg max-h-[90vh] rounded-md border border-dark-600 bg-dark-800 shadow-2xl overflow-hidden flex flex-col"
        style={{ animation: "scale-in 0.25s ease" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-dark-700 px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded bg-danger-500/15">
              <Lock className="h-5 w-5 text-danger-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-50">Закрытие смены</h2>
              <p className="text-xs text-dark-400">
                Открыта: {new Date(shift.openedAt).toLocaleString("ru-RU")}
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="rounded p-2 text-dark-400 hover:bg-dark-700 hover:text-dark-50 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {blind && (
            <div className="rounded border border-dark-600 bg-dark-700/50 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-dark-400">Начальная наличность</span>
                <span className="font-medium text-dark-50">{money(shift.openingCash)}</span>
              </div>
              <p className="text-sm text-dark-300">Пересчитайте наличные в кассе и введите сумму. Сколько должно быть, видит администратор.</p>
            </div>
          )}

          {!blind && (
          <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3">
            <SummaryCard icon={<TrendingUp className="h-4 w-4 text-primary-400" />} label="Общие продажи" value={money(shift.totalSales)} />
            <SummaryCard icon={<Banknote className="h-4 w-4 text-success-400" />} label="Наличные" value={money(shift.totalCashSales)} />
            <SummaryCard icon={<CreditCard className="h-4 w-4 text-primary-400" />} label="Карта" value={money(shift.totalCardSales)} />
            <SummaryCard icon={<QrCode className="h-4 w-4 text-primary-300" />} label="QR" value={money(shift.totalQrSales)} />
            {debtSales > 0 && <SummaryCard icon={<NotebookPen className="h-4 w-4 text-warning-400" />} label="В долг (не в кассе)" value={money(debtSales)} />}
            {repaidCash + repaidCard > 0 && (
              <SummaryCard
                icon={<HandCoins className="h-4 w-4 text-success-400" />}
                label={repaidCard > 0 ? `Погашено долгов (карта ${money(repaidCard)})` : "Погашено долгов"}
                value={money(repaidCash + repaidCard)}
              />
            )}
            {returnsCash + returnsOther > 0 && (
              <SummaryCard
                icon={<Undo2 className="h-4 w-4 text-danger-400" />}
                label={returnsOther > 0 ? `Возвраты (наличными ${money(returnsCash)})` : "Возвраты наличными"}
                value={money(returnsCash + returnsOther)}
              />
            )}
          </div>

          {/* Opening / Expected */}
          <div className="rounded border border-dark-600 bg-dark-700/50 p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-dark-400">Начальная наличность</span>
              <span className="font-medium text-dark-50">{money(shift.openingCash)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-dark-400">Ожидаемая наличность</span>
              <span className="font-bold text-primary-400">{money(expectedCash)}</span>
            </div>
          </div>
          </>
          )}

          {/* Closing cash input */}
          <div>
            <label htmlFor="closeshiftsc-f1" className="mb-2 block text-sm font-medium text-dark-300">
              Фактическая наличность в кассе
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-bold text-dark-400">{symbol}</span>
              <input id="closeshiftsc-f1"
                type="number"
                step="10000"
                value={closingCash}
                onChange={(e) => setClosingCash(e.target.value)}
                placeholder="0"
                className="w-full rounded border-2 border-dark-600 bg-dark-700 py-4 pl-12 pr-4 text-center text-3xl font-bold text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none transition-colors"
                autoFocus
              />
            </div>
          </div>

          {/* Quick amounts */}
          {!blind && (
          <div className="grid grid-cols-3 gap-2">
            {quickAmounts.map((amount) => (
              <button
                key={amount}
                onClick={() => setClosingCash(String(Math.round(amount)))}
                className="rounded border border-dark-600 bg-dark-700 py-2 text-xs font-semibold text-dark-300 transition-all hover:border-primary-500/50 hover:text-dark-50 active:scale-95"
              >
                {money(amount)}
              </button>
            ))}
          </div>
          )}

          {/* Difference indicator */}
          {closingCash && !blind && (
            <div
              className={`rounded border p-4 text-center ${
                difference === 0
                  ? "border-success-500/30 bg-success-500/10"
                  : difference > 0
                  ? "border-primary-500/30 bg-primary-500/10"
                  : "border-danger-500/30 bg-danger-500/10"
              }`}
              style={{ animation: "pop-in 0.2s ease" }}
            >
              <div className="flex items-center justify-center gap-2 mb-1">
                {difference !== 0 && <AlertTriangle className="h-4 w-4" />}
                <p className="text-xs font-medium text-dark-400">
                  {difference === 0 ? "Без расхождений" : difference > 0 ? "Излишек" : "Недостача"}
                </p>
              </div>
              <p
                className={`text-2xl font-bold ${
                  difference === 0 ? "text-success-500" : difference > 0 ? "text-primary-400" : "text-danger-400"
                }`}
              >
                {difference === 0 ? "0" : (difference > 0 ? "+" : "") + money(Math.abs(difference))}
              </p>
            </div>
          )}

          {/* Notes */}
          <div>
            <label htmlFor="closeshiftsc-f2" className="mb-2 block text-sm font-medium text-dark-300">Примечания</label>
            <textarea id="closeshiftsc-f2"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Необязательно..."
              rows={2}
              className="w-full rounded border-2 border-dark-600 bg-dark-700 py-3 px-4 text-sm text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none transition-colors resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-dark-700 px-6 py-4 shrink-0">
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="flex-1 rounded border border-dark-600 bg-dark-700 py-3 text-sm font-medium text-dark-300 hover:text-dark-50 transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={() => closeShift.mutate()}
              disabled={closeShift.isPending || !closingCash}
              className="flex-[2] flex items-center justify-center gap-2 rounded bg-danger-600 py-3 text-sm font-bold text-white transition-all hover:bg-danger-500 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {closeShift.isPending ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Закрытие...
                </>
              ) : (
                <>
                  Закрыть смену
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded border border-dark-600 bg-dark-700/50 p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-[11px] text-dark-400">{label}</span>
      </div>
      <p className="text-sm font-bold text-dark-50">{value}</p>
    </div>
  );
}
