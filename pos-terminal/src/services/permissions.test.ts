import { describe, it, expect } from "vitest";
import { mergePermissions } from "./permissions";

// Права кассира на кассе: сохранённые при входе, поверх — свежие с сервера.

describe("cashier permissions", () => {
  it("allow everything when nothing is known — the server decides", () => {
    expect(mergePermissions()).toEqual({ canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true, canRefund: true });
  });

  it("take what came with the sign-in", () => {
    expect(mergePermissions({ canSellOnDebt: false })).toMatchObject({ canSellOnDebt: false, canReceiveStock: true });
  });

  it("let a fresh answer override the sign-in — a ticked-off right hides the button without signing in again", () => {
    expect(mergePermissions({ canSellOnDebt: true }, { canSellOnDebt: false, canReceiveStock: true, canSeeExpectedCash: false, canRefund: false })).toEqual({
      canSellOnDebt: false,
      canReceiveStock: true,
      canSeeExpectedCash: false,
      canRefund: false,
    });
  });
});
