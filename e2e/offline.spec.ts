import { test, expect, type Page } from "@playwright/test";

// Офлайн-режим кассы магазина: связь пропала посреди дня — касса продаёт за
// наличные, чеки ждут на планшете; связь вернулась — каждый чек на сервере
// ровно один раз, склад уменьшился ровно на проданное. Демо-магазин «Барака»
// из prisma/seed.ts (как в cashier.spec.ts): молоко 3,2% — 13 500 сўм.

const API = `http://localhost:${process.env.E2E_BACKEND_PORT || 3200}/api`;
const MILK = "4780000000113";

async function managerGet<T>(page: Page, path: string): Promise<T> {
  const login = await page.request.post(`${API}/auth/login`, { data: { email: "market@wespro.com", password: "market123" } });
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
  const res = await page.request.get(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

// Каталог точки сохранён на планшете (IndexedDB qwik-offline, src/services/offlineDb.ts).
function catalogSaved(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open("qwik-offline", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("kv");
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const keys = request.result.transaction("kv").objectStore("kv").getAllKeys();
          keys.onsuccess = () => resolve(keys.result.some((key) => String(key).startsWith("catalog:")));
          keys.onerror = () => resolve(false);
        };
      })
  );
}

type OrderRow = { id: string; total: number; status: string; offlineAt: string | null };

test("without a connection the register sells for cash and sends every sale once when it is back", async ({ page, context }) => {
  // 1. Обычное начало дня, со связью: касса скачивает каталог точки.
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByText("Азиза Р.").click();
  for (const digit of "1234") await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Войти" }).click();

  const openShift = page.getByRole("button", { name: "Открыть смену" });
  const scan = page.getByPlaceholder("Штрихкод, код или название товара");
  await expect(openShift.or(scan)).toBeVisible();
  if (await openShift.isVisible()) {
    await page.getByRole("button", { name: "50К" }).click();
    await openShift.click();
  }
  await expect(scan).toBeFocused();
  await expect.poll(() => catalogSaved(page), { timeout: 15_000 }).toBe(true);

  const before = await managerGet<OrderRow[]>(page, "/orders?limit=50");
  const [milkBefore] = await managerGet<{ currentStock: number }[]>(page, `/products?search=${MILK}`);

  // 2. Связь пропала: три продажи за наличные.
  await context.setOffline(true);
  for (let i = 0; i < 3; i++) {
    await scan.fill(MILK);
    await scan.press("Enter");
    await expect(page.getByText("Молоко «Лактис» 3,2% 1 л").first()).toBeVisible();
    await page.keyboard.press("F8");
    await page.getByRole("button", { name: /Принять оплату/ }).click();
    await expect(page.getByText("Оплачено без связи")).toBeVisible();
    await expect(page.getByText("Чек пуст")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByText("Продаём только за наличные", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Не отправлено: 3/ })).toBeVisible();

  // Карта без связи не предлагается.
  await scan.fill(MILK);
  await scan.press("Enter");
  await expect(page.getByRole("button", { name: /Карта/ }).first()).toBeDisabled();

  // 3. Связь вернулась: чеки уходят сами, без нажатий.
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /Не отправлено|Отправляю чеки/ })).toHaveCount(0, { timeout: 30_000 });

  // 4. На сервере — ровно три новых продажи по 13 500, помеченные как офлайн,
  //    и склад меньше ровно на три бутылки (четвёртая ещё в корзине).
  const after = await managerGet<OrderRow[]>(page, "/orders?limit=50");
  const fresh = after.filter((order) => !before.some((old) => old.id === order.id));
  expect(fresh).toHaveLength(3);
  for (const order of fresh) expect(order).toMatchObject({ total: 13500, status: "completed" });
  expect(fresh.filter((order) => order.offlineAt)).toHaveLength(3);

  const [milkAfter] = await managerGet<{ currentStock: number }[]>(page, `/products?search=${MILK}`);
  expect(milkAfter.currentStock).toBe(milkBefore.currentStock - 3);

  // Повторная отправка (ещё раз «Отправить» или перезагрузка) ничего не добавляет.
  await page.reload();
  await expect(scan).toBeVisible();
  await page.waitForTimeout(2_000);
  expect((await managerGet<OrderRow[]>(page, "/orders?limit=50")).length).toBe(after.length);
});
