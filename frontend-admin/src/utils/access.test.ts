import { describe, it, expect, afterEach, vi } from "vitest";
import { canOpenPanel, canOpenPath, homePathFor, isRestaurantOnly, posUrl } from "./access";

// Кто что видит в панели. Данные закрывает бэкенд, но если навигация
// разойдётся с ним, кассир увидит экраны, на которых всё падает с 403, а повар —
// пустую панель вместо своей Кухни.

describe("who may open the panel", () => {
  it("lets in admins, managers and the kitchen, and no one else", () => {
    expect(canOpenPanel("admin")).toBe(true);
    expect(canOpenPanel("manager")).toBe(true);
    expect(canOpenPanel("kitchen")).toBe(true);
    for (const role of ["cashier", "waiter", "", null, undefined]) expect(canOpenPanel(role)).toBe(false);
  });

  it("keeps the kitchen on its own page", () => {
    expect(canOpenPath("kitchen", "/kitchen")).toBe(true);
    for (const path of ["/", "/products", "/reports", "/users", "/settings"]) expect(canOpenPath("kitchen", path)).toBe(false);
    expect(homePathFor("kitchen")).toBe("/kitchen");
  });

  it("opens every page to admins and managers", () => {
    for (const path of ["/", "/products", "/reports", "/users", "/kitchen"]) {
      expect(canOpenPath("admin", path)).toBe(true);
      expect(canOpenPath("manager", path)).toBe(true);
    }
    expect(homePathFor("admin")).toBe("/");
  });

  it("shows the design showcase to admins only", () => {
    expect(canOpenPath("admin", "/_design")).toBe(true);
    expect(canOpenPath("manager", "/_design")).toBe(false);
    expect(canOpenPath("kitchen", "/_design")).toBe(false);
  });

  it("opens nothing to a cashier who still has an old session", () => {
    expect(canOpenPath("cashier", "/")).toBe(false);
    expect(canOpenPath(undefined, "/")).toBe(false);
  });
});

describe("where the register lives", () => {
  afterEach(() => vi.unstubAllGlobals());

  const at = (href: string) => {
    const url = new URL(href);
    vi.stubGlobal("location", { protocol: url.protocol, hostname: url.hostname, host: url.host } as Location);
  };

  it("swaps admin. for pos. on a real domain", () => {
    at("https://admin.qwik.uz/settings");
    expect(posUrl()).toBe("https://pos.qwik.uz");
  });

  it("points at the terminal's port in local development", () => {
    at("http://localhost:5173/");
    expect(posUrl()).toBe("http://localhost:5174");
  });

  it("stays on the same host otherwise", () => {
    at("https://qwik-admin.up.railway.app/");
    expect(posUrl()).toBe("https://qwik-admin.up.railway.app");
  });
});

describe("sections a shop does not have", () => {
  it("are tech cards, categories, kitchen and tables", () => {
    for (const path of ["/tech-cards", "/categories", "/kitchen", "/tables"]) expect(isRestaurantOnly(path)).toBe(true);
  });

  it("leave everything a shop works with", () => {
    for (const path of ["/", "/products", "/orders", "/payments", "/inventory", "/stock-receipts", "/customers", "/cash-shifts", "/users", "/reports", "/settings"]) {
      expect(isRestaurantOnly(path)).toBe(false);
    }
  });
});
