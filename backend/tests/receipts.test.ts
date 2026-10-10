import { describe, expect, it } from "vitest";
import { receiptDateTime } from "../src/modules/receipts/receipt.service.js";

describe("время в чеке", () => {
  it("по часам точки, а не сервера: 20:30 UTC — это 01:30 следующего дня в Ташкенте", () => {
    expect(receiptDateTime(new Date("2026-10-09T20:30:00Z"), "Asia/Tashkent")).toEqual({ date: "10.10.2026", time: "01:30" });
  });

  it("неизвестный пояс — UTC, а не падение", () => {
    expect(receiptDateTime(new Date("2026-10-09T20:30:00Z"), "Mars/Base")).toEqual({ date: "09.10.2026", time: "20:30" });
  });
});
