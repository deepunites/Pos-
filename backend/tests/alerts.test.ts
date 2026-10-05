import { describe, it, expect } from "vitest";
import { AlertHub, isBug, parseDsn, stackFrames } from "../src/utils/alerts.js";
import { BASE_URL } from "./helpers.js";

// Уведомления об ошибках владельцу: Telegram + Sentry, склейка повторов,
// предел в час, ничего лишнего из запроса.

function hub(extra: Record<string, unknown> = {}) {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  let now = Date.parse("2026-10-05T10:00:00Z");
  const h = new AlertHub({
    telegramToken: "123:abc",
    telegramChatId: "42",
    telegramApi: "https://tg.test",
    environment: "production",
    release: "c6ffa2d",
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { h, sent, tick: (ms: number) => (now += ms) };
}

const telegram = (sent: { url: string; body: string }[]) => sent.filter((s) => s.url.startsWith("https://tg.test")).map((s) => JSON.parse(s.body).text as string);

describe("alerts", () => {
  it("send a bug to Telegram with where, who and the first line of our stack — HTML-safe", async () => {
    const { h, sent } = hub();
    const error = new TypeError("Cannot read properties of undefined (reading 'id') <b>");
    error.stack = `TypeError: x\n    at Object.checkout (/app/node_modules/express/router.js:1:1)\n    at OrderService.checkout (/app/src/modules/orders/order.service.ts:120:15)`;
    h.report(error, { where: "POST /api/orders/checkout", status: 500, who: "deep (cashier) · точка 1a2b3c4d" });
    await h.flush();
    const [text] = telegram(sent);
    expect(sent[0].url).toBe("https://tg.test/bot123:abc/sendMessage");
    expect(JSON.parse(sent[0].body)).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
    expect(text).toContain("<b>Qwik · сервер</b>");
    expect(text).toContain("POST /api/orders/checkout → 500");
    expect(text).toContain("&lt;b&gt;");
    expect(text).toContain("OrderService.checkout (/app/src/modules/orders/order.service.ts:120:15)");
    expect(text).toContain("deep (cashier)");
  });

  it("glue repeats together: one message, then a count after 15 minutes", async () => {
    const { h, sent, tick } = hub();
    // Одна и та же ошибка — одно место в коде.
    const boom = () => Object.assign(new TypeError("boom"), { stack: "TypeError: boom\n    at f (/app/src/x.ts:1:1)" });
    for (let i = 0; i < 5; i++) h.report(boom(), { source: "terminal", where: "/" });
    await h.flush();
    expect(telegram(sent)).toHaveLength(1);
    expect(telegram(sent)[0]).toContain("Qwik · касса");
    tick(16 * 60_000);
    h.report(boom(), { source: "terminal", where: "/" });
    await h.flush();
    expect(telegram(sent)).toHaveLength(2);
    expect(telegram(sent)[1]).toContain("Повторилась ещё 4 раз");
  });

  it("stop at 20 Telegram messages an hour with one notice, and start again next hour", async () => {
    const { h, sent, tick } = hub();
    for (let i = 0; i < 30; i++) h.report(new TypeError(`bug ${i}`));
    await h.flush();
    const texts = telegram(sent);
    expect(texts).toHaveLength(21);
    expect(texts[20]).toContain("ошибок больше 20 за час");
    tick(61 * 60_000);
    h.report(new TypeError("bug after an hour"));
    await h.flush();
    expect(telegram(sent)).toHaveLength(22);
  });

  it("send Sentry an envelope with the stack, oldest frame first", async () => {
    const { h, sent } = hub({ telegramToken: undefined, sentryDsn: "https://publickey@o123.ingest.sentry.io/4507" });
    const error = new RangeError("bad");
    error.stack = "RangeError: bad\n    at inner (/app/src/a.ts:2:3)\n    at outer (/app/src/b.ts:4:5)";
    h.report(error, { source: "admin", where: "/products", userAgent: "Chrome" });
    await h.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://o123.ingest.sentry.io/api/4507/envelope/");
    expect(sent[0].headers["X-Sentry-Auth"]).toContain("sentry_key=publickey");
    const [, item, event] = sent[0].body.split("\n").map((l) => JSON.parse(l));
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({ platform: "javascript", level: "error", environment: "production", release: "c6ffa2d", tags: { source: "admin" }, transaction: "/products" });
    expect(event.exception.values[0]).toMatchObject({ type: "RangeError", value: "bad" });
    expect(event.exception.values[0].stacktrace.frames.map((f: any) => f.function)).toEqual(["outer", "inner"]);
  });

  it("stay silent without keys, and never throw when the network fails", async () => {
    const silent = new AlertHub({});
    expect(silent.enabled).toBe(false);
    silent.report(new TypeError("x"));
    const { h } = hub({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(() => h.report(new TypeError("x"))).not.toThrow();
    await h.flush();
  });

  it("tell a bug from an ordinary refusal", () => {
    expect(isBug(new TypeError("x"), 400)).toBe(true);
    expect(isBug(new Error("Недостаточно товара"), 400)).toBe(false);
    expect(isBug(new Error("db down"), 500)).toBe(true);
  });

  it("read DSNs and stacks", () => {
    expect(parseDsn("https://k@sentry.example.com/sub/7")).toEqual({ url: "https://sentry.example.com/sub/api/7/envelope/", key: "k" });
    expect(parseDsn("not a dsn")).toBeNull();
    expect(stackFrames("Error\n    at http://pos.qwik.uz/assets/index-abc.js:1:2345")[0]).toMatchObject({ filename: "http://pos.qwik.uz/assets/index-abc.js", lineno: 1, colno: 2345 });
  });

  it("take browser errors at /client-errors without a sign-in, and check what comes in", async () => {
    const post = (body: unknown) => fetch(`${BASE_URL}/api/client-errors`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ source: "terminal", message: "TypeError: x is undefined", stack: "at a (x.js:1:1)", url: "https://pos.qwik.uz/" })).status).toBe(204);
    expect((await post({ source: "someone", message: "x" })).status).toBe(400);
    expect((await post({ source: "admin", message: "" })).status).toBe(400);
  });
});
