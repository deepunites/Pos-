import { create } from "zustand";
import { useCartStore } from "../store/cartStore";

// Новая версия кассы. Service worker ставит её в фоне, но страница работает на
// старой, пока её не перезагрузят, — касса, открытая с утра, не видела вечерних
// изменений («В долг» есть на сервере, а на кассе нет). Теперь: как только
// новая версия включилась, касса перезагружается сама — в паузе между
// продажами (чек пуст, окна закрыты); посреди продажи — только по кнопке.

interface AppUpdateState {
  ready: boolean;
}

export const useAppUpdate = create<AppUpdateState>(() => ({ ready: false }));

const CHECK_EVERY_MS = 15 * 60 * 1000;
const IDLE_CHECK_MS = 10 * 1000;

/** Касса свободна: чек пуст и не открыто ни одно окно (оплата, «Оплачено», приход…). */
function idle(): boolean {
  return useCartStore.getState().items.length === 0 && !document.querySelector('[role="dialog"]');
}

export function reloadNow(): void {
  window.location.reload();
}

export function watchAppUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  // Под старым service worker касса уже работала — смена хозяина значит новую
  // версию. Первая установка (хозяина не было) — не повод перезагружаться.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || useAppUpdate.getState().ready) return;
    useAppUpdate.setState({ ready: true });
    const timer = window.setInterval(() => {
      if (!idle()) return;
      window.clearInterval(timer);
      reloadNow();
    }, IDLE_CHECK_MS);
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        const check = () => void registration.update().catch(() => undefined);
        window.setInterval(check, CHECK_EVERY_MS);
        // Вернулись к кассе (планшет проснулся, вкладку открыли) — сразу спросить.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
      })
      .catch(() => undefined);
  });
}
