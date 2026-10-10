// One place that decides how money looks. Before this, the dashboard printed
// "₽", the product list printed "сўм" and the settings page claimed "USD" —
// all for the same numbers. Everything now formats through the tenant's
// configured currency.

export interface CurrencyFormat {
  symbol: string;
  /** Symbol goes after the amount (as it does for сўм) rather than before. */
  suffix: boolean;
  fractionDigits: number;
  locale: string;
}

const FORMATS: Record<string, CurrencyFormat> = {
  USD: { symbol: "$", suffix: false, fractionDigits: 2, locale: "en-US" },
  EUR: { symbol: "€", suffix: true, fractionDigits: 2, locale: "de-DE" },
  RUB: { symbol: "₽", suffix: true, fractionDigits: 2, locale: "ru-RU" },
  UZS: { symbol: "сўм", suffix: true, fractionDigits: 0, locale: "ru-RU" },
  KZT: { symbol: "₸", suffix: true, fractionDigits: 0, locale: "ru-RU" },
};

const DEFAULT_CURRENCY = "UZS";

export function currencyFormat(currency?: string | null): CurrencyFormat {
  return FORMATS[(currency || DEFAULT_CURRENCY).toUpperCase()] ?? {
    symbol: (currency || DEFAULT_CURRENCY).toUpperCase(),
    suffix: true,
    fractionDigits: 2,
    locale: "ru-RU",
  };
}

export function formatMoney(amount: number | string | null | undefined, currency?: string | null): string {
  const fmt = currencyFormat(currency);
  const value = Number(amount) || 0;
  const text = value.toLocaleString(fmt.locale, {
    minimumFractionDigits: fmt.fractionDigits,
    maximumFractionDigits: fmt.fractionDigits,
  });
  return fmt.suffix ? `${text} ${fmt.symbol}` : `${fmt.symbol}${text}`;
}

/** The number and the symbol apart, for screens that set the figure large and the symbol small. */
export function moneyParts(
  amount: number | string | null | undefined,
  currency?: string | null
): { figure: string; symbol: string; suffix: boolean } {
  const fmt = currencyFormat(currency);
  const figure = (Number(amount) || 0).toLocaleString(fmt.locale, {
    minimumFractionDigits: fmt.fractionDigits,
    maximumFractionDigits: fmt.fractionDigits,
  });
  return { figure, symbol: fmt.symbol, suffix: fmt.suffix };
}

export function currencySymbol(currency?: string | null): string {
  return currencyFormat(currency).symbol;
}

/**
 * Suggested cash denominations for the quick-fill buttons. The old terminal
 * hardcoded 100 000 … 1 000 000, which only makes sense for a currency without
 * minor units; a shop working in dollars got useless buttons.
 */
export function quickCashAmounts(currency?: string | null): number[] {
  const { fractionDigits } = currencyFormat(currency);
  return fractionDigits === 0
    ? [50_000, 100_000, 200_000, 500_000]
    : [10, 20, 50, 100];
}

/** Compact label for a denomination button ("100К" / "100"). */
export function compactAmount(amount: number, currency?: string | null): string {
  const { locale, fractionDigits } = currencyFormat(currency);
  if (fractionDigits === 0 && amount >= 1000) return `${amount / 1000}К`;
  return amount.toLocaleString(locale, { maximumFractionDigits: fractionDigits });
}

/**
 * Rounds to kopecks exactly as the server does (stock.helpers.round2), so the
 * total the cashier collects is the total the server computes — a difference
 * larger than a cent is rejected as "prices changed".
 */
export const round2 = (n: number): number => Math.round(n * 100) / 100;
