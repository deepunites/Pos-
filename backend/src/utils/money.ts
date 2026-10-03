// Same currency table as the terminal and the admin panel (utils/money.ts
// there): the printed receipt and the admin notifications must show the same
// amounts as the screen. They used to hardcode "₽" and two decimals, so a shop
// working in сўм got "22320.00 ₽" on paper. The locale is part of the table
// too — a dollar shop sees "$1,234.50" on screen, not "$1 234,50".

interface CurrencyFormat {
  symbol: string;
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

export function formatMoney(amount: number | string | null | undefined, currency?: string | null): string {
  const code = (currency || "USD").toUpperCase();
  const fmt = FORMATS[code] ?? { symbol: code, suffix: true, fractionDigits: 2, locale: "ru-RU" };
  const text = (Number(amount) || 0).toLocaleString(fmt.locale, {
    minimumFractionDigits: fmt.fractionDigits,
    maximumFractionDigits: fmt.fractionDigits,
  });
  return fmt.suffix ? `${text} ${fmt.symbol}` : `${fmt.symbol}${text}`;
}
