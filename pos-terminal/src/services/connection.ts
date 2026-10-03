import { create } from "zustand";

/**
 * Связь кассы с сервером.
 *
 * Офлайн-режима у кассы нет: пропала связь — чек не пробьётся. Кассир должен
 * узнать об этом до того, как отдаст товар, а не после ошибки оплаты.
 *
 * Источники: события браузера online/offline и сами запросы к API — ответ
 * сервера значит «на связи», запрос без ответа или ответ прокси 502–504 —
 * «нет». Пока связи нет, касса сама раз в несколько секунд проверяет
 * /api/health и снимает предупреждение, как только сервер ответил. Пока связь
 * есть — раз в 20 секунд и при возврате на вкладку: о пропаже связи кассир
 * узнаёт до оплаты, даже если касса сейчас ничего не запрашивает.
 */

/** device — у планшета нет сети; server — сеть есть, сервер не отвечает. */
export type ConnectionProblem = "device" | "server" | null;

interface ConnectionState {
  problem: ConnectionProblem;
  /** Когда пропала связь (мс), null — связь есть. */
  since: number | null;
  checking: boolean;
}

const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export const useConnection = create<ConnectionState>(() => ({
  problem: browserOffline() ? "device" : null,
  since: browserOffline() ? Date.now() : null,
  checking: false,
}));

export const PING_INTERVAL_MS = 5000;
export const HEARTBEAT_MS = 20_000;
const PING_TIMEOUT_MS = 4000;
let pingTimer: ReturnType<typeof setInterval> | null = null;

function setProblem(problem: ConnectionProblem): void {
  const { problem: current, since } = useConnection.getState();
  if (current === problem) return;
  useConnection.setState({ problem, since: problem ? since ?? Date.now() : null });
  if (problem && !pingTimer) {
    pingTimer = setInterval(() => void checkConnection(), PING_INTERVAL_MS);
  } else if (!problem && pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

export function reportReachable(): void {
  noteServerContact();
  setProblem(browserOffline() ? "device" : null);
}

export function reportUnreachable(): void {
  setProblem(browserOffline() ? "device" : "server");
}

/** Спросить сервер прямо сейчас. true — сервер ответил. */
export async function checkConnection(): Promise<boolean> {
  if (browserOffline()) {
    setProblem("device");
    return false;
  }
  useConnection.setState({ checking: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // ok — только настоящий ответ сервера: прокси при упавшем бэкенде отвечает 502.
    const res = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
    if (res.ok) reportReachable();
    else reportUnreachable();
    return res.ok;
  } catch {
    reportUnreachable();
    return false;
  } finally {
    clearTimeout(timeout);
    useConnection.setState({ checking: false });
  }
}

let watching = false;

/** Подписаться на события сети браузера. Вызывается один раз при запуске. */
export function watchConnection(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("offline", () => setProblem("device"));
  // Сеть вернулась — это ещё не значит, что сервер доступен: проверяем.
  window.addEventListener("online", () => void checkConnection());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkConnection();
  });
  // Пока связь есть — редкая проверка; без связи частую ведёт setProblem.
  setInterval(() => {
    if (!useConnection.getState().problem && document.visibilityState === "visible") void checkConnection();
  }, HEARTBEAT_MS);
}

// ── сколько касса уже без связи (офлайн-режим) ─────────────────────────────

/** Касса продаёт без связи не дольше двух суток; потом нужна связь. */
export const OFFLINE_LIMIT_MS = 48 * 3600 * 1000;
const CONTACT_KEY = "pos-last-contact";

/** Сервер ответил — запомнить когда (любой ответ, даже 4xx, значит, что связь есть). */
export function noteServerContact(now = Date.now()): void {
  try {
    localStorage.setItem(CONTACT_KEY, String(now));
  } catch {
    // без хранилища предел двух суток не проверить — не страшно
  }
}

/** Касса не говорила с сервером дольше двух суток — новые продажи без связи запрещены. */
export function offlineTooLong(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(CONTACT_KEY));
    return last > 0 && now - last > OFFLINE_LIMIT_MS;
  } catch {
    return false;
  }
}

/** Для тестов: вернуть начальное состояние. */
export function resetConnection(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  useConnection.setState({ problem: null, since: null, checking: false });
}
