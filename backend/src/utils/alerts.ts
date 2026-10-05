import { randomUUID } from "node:crypto";
import os from "node:os";
import { logger } from "./logger.js";

// Уведомления об ошибках владельцу: Telegram (узнать сразу) и Sentry (разобрать
// потом). Ключи — в переменных сервера: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID,
// SENTRY_DSN. Нет ключей — молчим. Ошибки кассы и админки приходят сюда же
// через POST /api/client-errors, поэтому фронтендам ключи не нужны.
//
// Одинаковые ошибки склеиваются: первая — сразу, повторы за 15 минут —
// одним счётчиком в следующем сообщении. Больше 20 сообщений в час в Telegram
// не уходит — дальше одно «ошибок слишком много» до конца часа.

export type AlertSource = "server" | "terminal" | "admin";

export interface AlertContext {
  source?: AlertSource;
  /** «POST /api/orders/checkout», адрес страницы кассы и т. п. */
  where?: string;
  /** Кто: «deep (cashier) · tenant 1a2b3c4d». */
  who?: string;
  status?: number;
  userAgent?: string;
  release?: string;
}

interface ErrorLike {
  name: string;
  message: string;
  stack?: string;
}

const SOURCE_TITLE: Record<AlertSource, string> = { server: "сервер", terminal: "касса", admin: "админка" };
const DEDUP_MS = 15 * 60_000;
const TELEGRAM_PER_HOUR = 20;
const SENTRY_PER_HOUR = 200;

type Fetch = typeof fetch;

export interface AlertConfig {
  telegramToken?: string;
  telegramChatId?: string;
  telegramApi?: string;
  sentryDsn?: string;
  environment?: string;
  release?: string;
  fetch?: Fetch;
  now?: () => number;
}

interface Seen {
  lastSentAt: number;
  suppressed: number;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  if (error && typeof error === "object" && "message" in error) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    return { name: String(e.name ?? "Error"), message: String(e.message), stack: typeof e.stack === "string" ? e.stack : undefined };
  }
  return { name: "Error", message: String(error) };
}

/** Первая строка стека из нашего кода — по ней одинаковые ошибки склеиваются. */
function topFrame(stack?: string): string {
  const lines = (stack ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
  return (lines.find((l) => !l.includes("node_modules") && !l.includes("node:")) ?? lines[0] ?? "").replace(/^at\s+/, "");
}

/** Кадры стека V8 («at fn (file:line:col)») в формате Sentry — старые первыми. */
export function stackFrames(stack?: string) {
  const frames = (stack ?? "")
    .split("\n")
    .map((line) => line.trim().match(/^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({
      function: m[1] || "?",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2].includes("node_modules") && !m[2].startsWith("node:"),
    }));
  return frames.reverse();
}

export function parseDsn(dsn: string): { url: string; key: string } | null {
  const m = dsn.match(/^(https?):\/\/([^@:]+)(?::[^@]*)?@([^/]+)\/(?:(.*)\/)?(\d+)$/);
  if (!m) return null;
  const [, protocol, key, host, path, projectId] = m;
  return { url: `${protocol}://${host}/${path ? `${path}/` : ""}api/${projectId}/envelope/`, key };
}

export class AlertHub {
  private seen = new Map<string, Seen>();
  private sentryLast = new Map<string, number>();
  private telegramSent: number[] = [];
  private sentrySent: number[] = [];
  private mutedNoticeAt = 0;
  private pending = new Set<Promise<unknown>>();

  constructor(private config: AlertConfig) {}

  get enabled(): boolean {
    return Boolean((this.config.telegramToken && this.config.telegramChatId) || this.config.sentryDsn);
  }

  private now() {
    return this.config.now?.() ?? Date.now();
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Дождаться отправки (перед выходом процесса), не дольше timeoutMs. */
  async flush(timeoutMs = 3000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  report(error: unknown, context: AlertContext = {}): void {
    if (!this.enabled) return;
    const err = toErrorLike(error);
    const source = context.source ?? "server";
    const fingerprint = `${source}|${err.name}|${err.message.slice(0, 200)}|${topFrame(err.stack)}`;
    const now = this.now();

    // Sentry: каждое — но одинаковую не чаще раза в минуту и всего не больше 200 в час.
    this.sentrySent = this.sentrySent.filter((t) => now - t < 3600_000);
    const sentryLast = this.sentryLast.get(fingerprint);
    if (this.config.sentryDsn && this.sentrySent.length < SENTRY_PER_HOUR && (sentryLast === undefined || now - sentryLast >= 60_000)) {
      this.sentrySent.push(now);
      this.sentryLast.set(fingerprint, now);
      if (this.sentryLast.size > 500) this.sentryLast.delete(this.sentryLast.keys().next().value!);
      this.track(this.sendSentry(err, source, context));
    }

    const prev = this.seen.get(fingerprint);

    // Telegram: первая — сразу, повторы за 15 минут — счётчиком.
    if (prev && now - prev.lastSentAt < DEDUP_MS) {
      prev.suppressed += 1;
      return;
    }
    const repeated = prev?.suppressed ?? 0;
    this.seen.set(fingerprint, { lastSentAt: now, suppressed: 0 });
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);

    if (!this.config.telegramToken || !this.config.telegramChatId) return;
    this.telegramSent = this.telegramSent.filter((t) => now - t < 3600_000);
    if (this.telegramSent.length >= TELEGRAM_PER_HOUR) {
      if (now - this.mutedNoticeAt > 3600_000) {
        this.mutedNoticeAt = now;
        this.track(this.sendTelegram(`⚠️ <b>Qwik</b>: ошибок больше ${TELEGRAM_PER_HOUR} за час — дальше молчу до конца часа. Подробности — в Sentry и логах Railway.`));
      }
      return;
    }
    this.telegramSent.push(now);
    this.track(this.sendTelegram(this.format(err, source, context, repeated)));
  }

  /** Сообщение без ошибки — «сервер запущен» и т. п. Только в Telegram. */
  notify(text: string): void {
    if (!this.config.telegramToken || !this.config.telegramChatId) return;
    this.track(this.sendTelegram(text));
  }

  format(err: ErrorLike, source: AlertSource, context: AlertContext, repeated = 0): string {
    const lines = [`🔴 <b>Qwik · ${SOURCE_TITLE[source]}</b>${this.config.environment && this.config.environment !== "production" ? ` (${escapeHtml(this.config.environment)})` : ""}`];
    if (context.where) lines.push((source === "server" ? "" : "Страница ") + escapeHtml(context.where) + (context.status ? ` → ${context.status}` : ""));
    lines.push(`<code>${escapeHtml(`${err.name}: ${err.message}`.slice(0, 600))}</code>`);
    const frame = topFrame(err.stack);
    if (frame) lines.push(`<i>${escapeHtml(frame.slice(0, 200))}</i>`);
    if (context.who) lines.push(escapeHtml(context.who));
    if (repeated > 0) lines.push(`Повторилась ещё ${repeated} раз за 15 минут до этого`);
    return lines.join("\n");
  }

  private async post(url: string, init: RequestInit): Promise<Response | null> {
    const doFetch = this.config.fetch ?? fetch;
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (error) {
      // Уведомление не ушло — пишем в лог и живём дальше: из-за Telegram касса падать не должна.
      logger.warn("Alert not delivered", { url: url.replace(/bot[^/]+/, "bot***"), message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async sendTelegram(text: string) {
    const base = this.config.telegramApi ?? "https://api.telegram.org";
    const res = await this.post(`${base}/bot${this.config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.telegramChatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (res && !res.ok) logger.warn("Telegram refused the alert", { status: res.status });
  }

  private async sendSentry(err: ErrorLike, source: AlertSource, context: AlertContext) {
    const dsn = parseDsn(this.config.sentryDsn!);
    if (!dsn) return;
    const eventId = randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: this.now() / 1000,
      platform: source === "server" ? "node" : "javascript",
      level: "error",
      environment: this.config.environment,
      release: context.release ?? this.config.release,
      server_name: source === "server" ? os.hostname() : undefined,
      tags: { source, ...(context.status ? { status: String(context.status) } : {}) },
      transaction: context.where,
      user: context.who ? { username: context.who } : undefined,
      request: context.userAgent ? { headers: { "User-Agent": context.userAgent } } : undefined,
      exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames: stackFrames(err.stack) } }] },
    };
    const body = [JSON.stringify({ event_id: eventId, sent_at: new Date(this.now()).toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    const res = await this.post(dsn.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=qwik/1.0` },
      body,
    });
    if (res && !res.ok) logger.warn("Sentry refused the event", { status: res.status });
  }
}

export const alerts = new AlertHub({
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  // Для проверки на своей машине: подставной сервер вместо api.telegram.org.
  telegramApi: process.env.TELEGRAM_API_URL,
  sentryDsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
});

/**
 * Стоит ли будить владельца: ошибка кода (TypeError и т. п.), сбой базы или
 * ответ 5xx. Обычный отказ («Недостаточно товара», «Неверный PIN») — нет.
 */
export function isBug(error: unknown, status: number): boolean {
  if (status >= 500) return true;
  const name = error instanceof Error ? error.name : "";
  return ["TypeError", "ReferenceError", "RangeError", "SyntaxError", "PrismaClientUnknownRequestError", "PrismaClientValidationError", "PrismaClientInitializationError", "PrismaClientRustPanicError"].includes(name);
}

/** Где и у кого случилось — из запроса Express (без тела запроса и без токенов). */
export function requestContext(req: { method?: string; originalUrl?: string; user?: { id: string; role: string; tenantId: string; email?: string } } | undefined, status?: number): AlertContext {
  if (!req) return { status };
  const path = (req.originalUrl ?? "").split("?")[0];
  const u = req.user;
  return {
    where: `${req.method ?? ""} ${path}`.trim(),
    status,
    who: u ? `${u.email ?? u.id} (${u.role}) · точка ${u.tenantId.slice(0, 8)}` : undefined,
  };
}
