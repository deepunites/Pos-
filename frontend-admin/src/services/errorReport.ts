// Ошибки страницы — серверу (POST /api/client-errors), а он перешлёт их
// владельцу в Telegram и Sentry. Своих ключей у браузера нет.
//
// Не шлём: обрывы связи и ответы API (их видит сервер), шум браузера
// (ResizeObserver, «Script error.» чужих скриптов), старые куски сборки после
// обновления. Одна и та же ошибка — не чаще раза в 5 минут, всего — 10 за сеанс.

const SOURCE = "admin";
const MAX_PER_SESSION = 10;
const REPEAT_MS = 5 * 60_000;

const NOISE = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Network ?Error/i,
  /Failed to fetch/i,
  /Load failed/i,
  /dynamically imported module/i,
  /Importing a module script failed/i,
  /AbortError|aborted/i,
  /timeout of \d+ms exceeded/i,
];

const seen = new Map<string, number>();
let sent = 0;

interface Reported {
  name: string;
  message: string;
  stack?: string;
}

function normalize(error: unknown): Reported | null {
  if (!error) return null;
  // Ошибка запроса к API: сервер уже знает о своих сбоях, обрыв связи — не баг.
  if (typeof error === "object" && (error as { isAxiosError?: boolean }).isAxiosError) return null;
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  if (typeof error === "string") return { name: "Error", message: error };
  return { name: "Error", message: String((error as { message?: unknown }).message ?? error) };
}

function token(): string | null {
  try {
    return JSON.parse(localStorage.getItem("pos-auth") || "{}")?.state?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Отправить ошибку; true — ушла (для тестов). */
export function reportError(error: unknown, now = Date.now()): boolean {
  const e = normalize(error);
  if (!e || !e.message || NOISE.some((r) => r.test(e.message))) return false;
  const key = `${e.name}|${e.message}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return false;
  if (sent >= MAX_PER_SESSION) return false;
  seen.set(key, now);
  sent += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  void fetch("/api/client-errors", {
    method: "POST",
    headers,
    keepalive: true,
    body: JSON.stringify({ source: SOURCE, name: e.name.slice(0, 100), message: e.message.slice(0, 1000), stack: e.stack?.slice(0, 8000), url: location.href.slice(0, 500) }),
  }).catch(() => undefined);
  return true;
}

/** Для тестов: начать сеанс заново. */
export function resetErrorReporting(): void {
  seen.clear();
  sent = 0;
}

export function installErrorReporting(): void {
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
}
