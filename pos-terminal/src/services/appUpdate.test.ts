import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Касса подхватывает новую версию сама: в паузе между продажами, а не посреди чека.

type Listener = () => void;

async function setup(hadController: boolean) {
  vi.resetModules();
  vi.useFakeTimers();
  const listeners: Record<string, Listener> = {};
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: hadController ? {} : null,
      addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
      register: vi.fn(() => Promise.resolve({ update: vi.fn(() => Promise.resolve()) })),
    },
  });
  const reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  const update = await import("./appUpdate");
  const { useCartStore } = await import("../store/cartStore");
  update.watchAppUpdate();
  return { listeners, reload, useAppUpdate: update.useAppUpdate, useCartStore };
}

describe("app update", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads into the new version as soon as the register is idle", async () => {
    const { listeners, reload, useAppUpdate, useCartStore } = await setup(true);
    useCartStore.setState({ items: [] });
    listeners.controllerchange();
    expect(useAppUpdate.getState().ready).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits while a check is being rung up or a window is open", async () => {
    const { listeners, reload, useCartStore } = await setup(true);
    useCartStore.setState({ items: [{ id: "1", productId: "p", name: "Сок", price: 1, quantity: 1 } as never] });
    listeners.controllerchange();
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();

    useCartStore.setState({ items: [] });
    document.body.innerHTML = '<div role="dialog">Оплачено</div>';
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();

    document.body.innerHTML = "";
    vi.advanceTimersByTime(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on the very first install", async () => {
    const { listeners, reload, useAppUpdate } = await setup(false);
    listeners.controllerchange();
    vi.advanceTimersByTime(60_000);
    expect(useAppUpdate.getState().ready).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
