import { describe, it, expect, beforeEach, vi } from "vitest";
import { reportError, resetErrorReporting } from "./errorReport";

// Ошибки страницы уходят на сервер — но без шума, повторов и потопа.

describe("error reporting", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    resetErrorReporting();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends a real bug to the server", () => {
    expect(reportError(new TypeError("Cannot read properties of undefined (reading 'price')"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/client-errors");
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "TypeError", message: "Cannot read properties of undefined (reading 'price')" });
  });

  it("skips lost connection, API answers and browser noise", () => {
    expect(reportError(new Error("Network Error"))).toBe(false);
    expect(reportError(new TypeError("Failed to fetch"))).toBe(false);
    expect(reportError(Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true }))).toBe(false);
    expect(reportError("ResizeObserver loop completed with undelivered notifications.")).toBe(false);
    expect(reportError("Script error.")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the same error once in five minutes and at most ten a session", () => {
    const t = Date.parse("2026-10-05T10:00:00Z");
    expect(reportError(new TypeError("same"), t)).toBe(true);
    expect(reportError(new TypeError("same"), t + 60_000)).toBe(false);
    expect(reportError(new TypeError("same"), t + 6 * 60_000)).toBe(true);
    for (let i = 0; i < 20; i++) reportError(new TypeError(`bug ${i}`), t);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
