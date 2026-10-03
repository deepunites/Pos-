import { useQuery } from "@tanstack/react-query";
import api from "../services/api";
import { sessionClaims } from "../services/session";
import { isNoConnection } from "../utils/apiError";
import { compactAmount, currencyFormat, currencySymbol, formatMoney, moneyParts, quickCashAmounts } from "../utils/money";

/**
 * Money formatter bound to the tenant's configured currency. Cached by
 * react-query, so all screens share one settings request — and one answer to
 * "which currency is this shop in" instead of the hardcoded сўм/₽/$ mix.
 */
// Настройки точки, сохранённые при последнем ответе сервера. Без связи после
// перезагрузки касса магазина иначе открылась бы кафе в долларах — и продавать
// без связи было бы нечем (офлайн-режим).
const SETTINGS_KEY = "pos-settings";

function savedSettings(): Record<string, unknown> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    return saved && saved.id === sessionClaims()?.tenantId ? saved : null;
  } catch {
    return null;
  }
}

async function loadSettings() {
  try {
    const data = (await api.get("/settings")).data.data;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {
      // без хранилища — просто без офлайн-копии
    }
    return data;
  } catch (error) {
    const saved = isNoConnection(error) ? savedSettings() : null;
    if (saved) return saved;
    throw error;
  }
}

export function useMoney() {
  const { data: settings, isError } = useQuery({
    queryKey: ["settings"],
    queryFn: loadSettings,
    staleTime: 5 * 60 * 1000,
  });

  const currency: string = settings?.currency || "USD";

  return {
    currency,
    shopName: (settings?.name as string | undefined) || "Qwik",
    symbol: currencySymbol(currency),
    money: (amount: number | string | null | undefined) => formatMoney(amount, currency),
    parts: (amount: number | string | null | undefined) => moneyParts(amount, currency),
    fractionDigits: currencyFormat(currency).fractionDigits,
    businessType: ((settings?.businessType as string | undefined) ?? "cafe") as "cafe" | "retail",
    // On a failed request the register falls back to the café layout instead of spinning forever.
    settingsLoaded: settings !== undefined || isError,
    quickAmounts: quickCashAmounts(currency),
    compact: (amount: number) => compactAmount(amount, currency),
  };
}
