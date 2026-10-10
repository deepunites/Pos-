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

export function currencySymbol(currency?: string | null): string {
  return currencyFormat(currency).symbol;
}
