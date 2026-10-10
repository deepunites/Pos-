import { useSettings } from "./useSettings";
import { currencySymbol, formatMoney } from "../utils/money";

/**
 * Money formatter bound to the tenant's configured currency. The settings
 * response is cached by react-query, so every screen shares one request and
 * one answer to "which currency is this shop in".
 */
export function useMoney() {
  const { data: settings } = useSettings();

  const currency: string = settings?.currency || "UZS";

  return {
    currency,
    symbol: currencySymbol(currency),
    money: (amount: number | string | null | undefined) => formatMoney(amount, currency),
  };
}
