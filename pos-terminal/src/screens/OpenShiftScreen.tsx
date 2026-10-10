import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Lock, ArrowRight } from "lucide-react";
import api from "../services/api";
import toast from "react-hot-toast";
import type { CashShift } from "../types";
import { useMoney } from "../hooks/useMoney";
import { apiErrorMessage } from "../utils/apiError";
import { useHoldAppUpdate } from "../services/appUpdate";


interface OpenShiftScreenProps {
  user: { firstName: string; lastName: string };
  onShiftOpened: (shift: CashShift) => void;
}

export default function OpenShiftScreen({ user, onShiftOpened }: OpenShiftScreenProps) {
  useHoldAppUpdate();
  const { money, symbol, quickAmounts: denominations, compact } = useMoney();
  const [openingCash, setOpeningCash] = useState("");

  const openShift = useMutation({
    mutationFn: async () => {
      const res = await api.post("/cash-shifts/open", {
        openingCash: parseFloat(openingCash) || 0,
      });
      return res.data.data as CashShift;
    },
    onSuccess: (shift) => {
      toast.success("Смена открыта!");
      onShiftOpened(shift);
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, "Не удалось открыть смену — повторите"));
    },
  });

  const quickAmounts = [0, ...denominations];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950">
      <div
        className="mx-4 w-full max-w-md rounded-md border border-dark-600 bg-dark-800 shadow-2xl overflow-hidden"
        style={{ animation: "scale-in 0.3s ease" }}
      >
        {/* Header */}
        <div className="border-b border-dark-700 px-6 py-5 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded bg-primary-600/15 mb-3">
            <Lock className="h-7 w-7 text-primary-400" />
          </div>
          <h2 className="text-xl font-bold text-dark-50">Открытие смены</h2>
          <p className="mt-1 text-sm text-dark-400">
            {user.firstName} {user.lastName}
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="openshiftscr-f1" className="mb-2 block text-sm font-medium text-dark-300">
              Начальная наличность в кассе
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-bold text-dark-400">{symbol}</span>
              <input id="openshiftscr-f1"
                type="number"
                step="10000"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                placeholder="0"
                className="w-full rounded border-2 border-dark-600 bg-dark-700 py-4 pl-12 pr-4 text-center text-3xl font-bold text-dark-50 placeholder:text-dark-500 focus:border-primary-500 focus:outline-none transition-colors"
                autoFocus
              />
            </div>
            {openingCash && (
              <p className="mt-2 text-center text-sm text-primary-400">
                {money(parseFloat(openingCash) || 0)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-5 gap-2">
            {quickAmounts.map((amount) => (
              <button
                key={amount}
                onClick={() => setOpeningCash(String(amount))}
                className={`rounded border py-2.5 text-xs font-semibold transition-all active:scale-95 ${
                  openingCash === String(amount)
                    ? "border-primary-500 bg-primary-600/20 text-primary-400"
                    : "border-dark-600 bg-dark-700 text-dark-300 hover:border-dark-500 hover:text-dark-50"
                }`}
              >
                {amount === 0 ? "0" : compact(amount)}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-dark-700 px-6 py-4">
          <button
            onClick={() => openShift.mutate()}
            disabled={openShift.isPending}
            className="flex w-full items-center justify-center gap-2 rounded bg-primary-600 py-4 text-base font-bold text-white transition-all hover:bg-primary-500 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {openShift.isPending ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Открытие...
              </>
            ) : (
              <>
                Открыть смену
                <ArrowRight className="h-5 w-5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
