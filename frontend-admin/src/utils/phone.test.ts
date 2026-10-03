import { describe, it, expect } from "vitest";
import { formatLocal, fullPhone, localDigits } from "./phone";

// Телефон клиента: +998 касса ставит сама, кассир набирает девять цифр.

describe("local digits", () => {
  it("keeps what the cashier types, digits only, at most nine", () => {
    expect(localDigits("90 123-45-67")).toBe("901234567");
    expect(localDigits("9012345678")).toBe("901234567");
    expect(localDigits("абв")).toBe("");
  });

  it("drops the country code from a pasted or fully typed number", () => {
    expect(localDigits("+998 90 123 45 67")).toBe("901234567");
    expect(localDigits("998901234567")).toBe("901234567");
    // набирают +998 по привычке — на десятой цифре код уходит сам
    expect(localDigits("9989012345")).toBe("9012345");
  });

  it("does not eat a local number that happens to start with 998", () => {
    expect(localDigits("998123456")).toBe("998123456");
  });

  it("reads a phone saved earlier in full", () => {
    expect(localDigits("+998901234567")).toBe("901234567");
  });
});

describe("formatting", () => {
  it("groups the digits as they are typed", () => {
    expect(formatLocal("")).toBe("");
    expect(formatLocal("9")).toBe("9");
    expect(formatLocal("90")).toBe("90");
    expect(formatLocal("901")).toBe("90 1");
    expect(formatLocal("90123")).toBe("90 123");
    expect(formatLocal("901234")).toBe("90 123-4");
    expect(formatLocal("9012345")).toBe("90 123-45");
    expect(formatLocal("90123456")).toBe("90 123-45-6");
    expect(formatLocal("901234567")).toBe("90 123-45-67");
  });

  it("never ends on a separator, so backspace always removes a digit", () => {
    for (let n = 0; n <= 9; n++) expect(formatLocal("901234567".slice(0, n))).not.toMatch(/[ -]$/);
  });
});

describe("full phone", () => {
  it("adds +998 to nine digits", () => {
    expect(fullPhone("901234567")).toBe("+998901234567");
  });

  it("means «no phone» when nothing is typed and «not finished» otherwise", () => {
    expect(fullPhone("")).toBeUndefined();
    expect(fullPhone("9012")).toBeNull();
  });
});
