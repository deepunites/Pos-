import { describe, it, expect } from "vitest";
import { compactAmount, currencyFormat, currencySymbol, formatMoney, moneyParts, quickCashAmounts, round2 } from "./money";

// Деньги выглядят одинаково на кассе, в чеке и в панели: формат задаёт валюта
// заведения. Пробелы-разделители в числах Intl ставит неразрывные — сравниваем
// с ними, а не с обычными.
const SPACES = new RegExp("[" + String.fromCharCode(0xa0, 0x202f) + "]", "g");
const nb = (s: string) => s.replace(SPACES, " ");

describe("formatMoney", () => {
  it("formats the sum without kopecks and after the number", () => {
    expect(nb(formatMoney(1234567, "UZS"))).toBe("1 234 567 сўм");
    expect(nb(formatMoney(1234567.6, "UZS"))).toBe("1 234 568 сўм");
  });

  it("formats dollars with cents and the sign in front", () => {
    expect(formatMoney(1234.5, "USD")).toBe("$1,234.50");
  });

  it("formats euro, rouble and tenge in their own way", () => {
    expect(nb(formatMoney(1234.5, "EUR"))).toBe("1.234,50 €");
    expect(nb(formatMoney(1234.5, "RUB"))).toBe("1 234,50 ₽");
    expect(nb(formatMoney(1234.5, "KZT"))).toBe("1 235 ₸");
  });

  it("treats missing or bad amounts as zero and an unknown currency by its code", () => {
    expect(formatMoney(null, "USD")).toBe("$0.00");
    expect(formatMoney("abc", "USD")).toBe("$0.00");
    expect(nb(formatMoney(10, "GBP"))).toBe("10,00 GBP");
    expect(currencyFormat(undefined).symbol).toBe("сўм"); // точка без валюты — сумы (продаём в Узбекистане)
    expect(currencySymbol("uzs")).toBe("сўм");
  });
});

describe("moneyParts", () => {
  it("splits the figure from the symbol for the big total on screen", () => {
    const parts = moneyParts(150000, "UZS");
    expect(nb(parts.figure)).toBe("150 000");
    expect(parts).toMatchObject({ symbol: "сўм", suffix: true });
  });
});

describe("quick cash buttons", () => {
  it("offers round banknotes of the currency", () => {
    expect(quickCashAmounts("UZS")).toEqual([50_000, 100_000, 200_000, 500_000]);
    expect(quickCashAmounts("USD")).toEqual([10, 20, 50, 100]);
  });

  it("labels big sums briefly", () => {
    expect(compactAmount(100_000, "UZS")).toBe("100К");
    expect(compactAmount(20, "USD")).toBe("20");
  });
});

// round2 повторяет серверный stock.helpers.round2: итог, который касса
// показывает, — тот же, что посчитает сервер.
describe("round2", () => {
  it("rounds to kopecks the same way the server does", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(12.345)).toBe(12.35);
    expect(round2(1.005)).toBe(1); // как и Math.round на сервере: 1.005 в float — это 1.00499…
    expect(round2(-2.5)).toBe(-2.5);
  });
});
