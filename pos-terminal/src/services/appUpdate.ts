import { useEffect } from "react";
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

// Экраны, на которых кассир что-то набирает (приход, закрытие и открытие
// смены, чек кафе), держат перезагрузку: «чек пуст и окон нет» их не видит —
// у них нет role="dialog", и приход из десятков позиций терялся целиком.
let holds = 0;

/** Задержать перезагрузку; вернуть — отпустить. */
export function holdAppUpdate(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}

/** Пока экран открыт, касса сама не перезагружается для обновления. */
export function useHoldAppUpdate(): void {
  useEffect(() => holdAppUpdate(), []);
}

/** Касса свободна: чек пуст, не открыто ни одно окно (оплата, «Оплачено»…) и ни один экран с вводом. */
export function idle(): boolean {
  return holds === 0 && useCartStore.getState().items.length === 0 && !document.querySelector('[role="dialog"]');
}

export function reloadNow(): void {
  window.location.reload();
}

export function watchAppUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  // Под старым service worker касса уже работала — смена хозяина значит новую
  // версию. Первая установка (хозяина не было) — не повод перезагружаться, но
  // после неё страница уже под service worker'ом, и следующая смена хозяина —
  // новая версия (раньше признак запоминался один раз, и на свежей установке
  // все выкатки до ручной перезагрузки молча пропускались).
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (useAppUpdate.getState().ready) return;
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
