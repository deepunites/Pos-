import { test, expect, type Page } from "@playwright/test";

// Рабочий день кассира магазина, от привязки планшета до оплаты, — в браузере,
// против настоящего бэкенда. Демо-магазин «Барака» из prisma/seed.ts: код точки
// demo-market, кассир Азиза, PIN 1234; молоко 3,2% — 13 500 сўм, 60 шт на
// складе; хлеб «Нон» белый — 4 500 сўм, кнопка «одно касание», 80 шт.

const API = `http://localhost:${process.env.E2E_BACKEND_PORT || 3200}/api`;
const MILK = "4780000000113";

async function pressPin(page: Page, pin: string) {
  for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Войти" }).click();
}

// Запрос к API от имени кассира (токен кассы) или управляющего точки: список
// заказов кассиру не положен — так и должно быть, — поэтому проверяем как
// управляющий из того же сида (market@wespro.com).
async function api<T>(page: Page, path: string, as: "cashier" | "manager" = "manager"): Promise<T> {
  const token =
    as === "cashier"
      ? await page.evaluate(() => localStorage.getItem("pos-token"))
      : ((await (await page.request.post(`${API}/auth/login`, { data: { email: "market@wespro.com", password: "market123" } })).json()) as {
          data: { accessToken: string };
        }).data.accessToken;
  const res = await page.request.get(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test("a cashier pairs the register, signs in, sells and gets paid", async ({ page }) => {
  // 1. Новый планшет: привязка к точке по коду.
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();

  // 2. Плитка кассира и PIN.
  await page.getByText("Азиза Р.").click();
  await pressPin(page, "1234");

  // 3. Смена.
  await page.getByRole("button", { name: "50К" }).click();
  await page.getByRole("button", { name: "Открыть смену" }).click();

  // 4. Скан с множителем — две бутылки одной строкой; хлеб — одним касанием.
  const scan = page.getByPlaceholder("Штрихкод, код или название товара");
  await scan.fill(`2*${MILK}`);
  await scan.press("Enter");
  await expect(page.getByText("Молоко «Лактис» 3,2% 1 л")).toBeVisible();
  await page.getByText("Хлеб «Нон» белый").first().click();
  await expect(page.getByText(/31\s500\s*сўм/).first()).toBeVisible();

  // 5. Наличные: F8 — правая панель переходит в оплату, без сдачи.
  await page.keyboard.press("F8");
  await page.getByRole("button", { name: "Оплатить", exact: true }).click();
  await expect(page.getByText("Чек пуст")).toBeVisible();

  // 6. Сервер видит то же, что касса: оплаченный заказ на 31 500, склад
  //    уменьшился ровно на проданное, продажа — в открытой смене.
  const orders = await api<{ total: number; status: string; items: { quantity: number }[] }[]>(page, "/orders?limit=5");
  expect(orders[0]).toMatchObject({ total: 31500, status: "completed" });
  expect(orders[0].items.reduce((n, i) => n + i.quantity, 0)).toBe(3);

  const [milk] = await api<{ currentStock: number }[]>(page, `/products?search=${MILK}`);
  expect(milk.currentStock).toBe(58);
  const [bread] = await api<{ currentStock: number }[]>(page, `/products?search=${encodeURIComponent("Хлеб «Нон» белый")}`);
  expect(bread.currentStock).toBe(79);

  const shift = await api<{ totalCashSales: number; expectedCash: number }>(page, "/cash-shifts/current", "cashier");
  expect(shift).toMatchObject({ totalCashSales: 31500, expectedCash: 50000 + 31500 });
});

test("the register remembers its shop and its cashier after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByText("Азиза Р.").click();
  await pressPin(page, "1234");
  await expect(page.getByText(/Сканер готов|Открытие смены/).first()).toBeVisible();

  await page.reload();

  // Без повторной привязки и PIN — сразу рабочий экран.
  await expect(page.getByText(/Сканер готов|Открытие смены/).first()).toBeVisible();
  await expect(page.getByPlaceholder("например, my-shop")).toHaveCount(0);
});

test("card + cash: the cashier types the card part, the cash part counts itself", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByText("Азиза Р.").click();
  await pressPin(page, "1234");
  const openShift = page.getByRole("button", { name: "Открыть смену" });
  await expect(page.getByText(/Сканер готов|Открытие смены/).first()).toBeVisible();
  if (await openShift.isVisible()) {
    await page.getByRole("button", { name: "50К" }).click();
    await openShift.click();
  }
  const before = await api<{ totalCashSales: number; totalCardSales: number }>(page, "/cash-shifts/current", "cashier");

  const scan = page.getByPlaceholder("Штрихкод, код или название товара");
  await scan.fill(`2*${MILK}`);
  await scan.press("Enter");
  await page.getByText("Хлеб «Нон» белый").first().click();
  await expect(page.getByText(/31\s500\s*сўм/).first()).toBeVisible();

  // F10 — «Карта + наличные»: набрали сумму картой, наличные — остаток сами.
  await page.keyboard.press("F10");
  await page.keyboard.type("20000");
  await expect(page.getByText(/11\s500/).first()).toBeVisible();
  await page.getByRole("button", { name: /^Оплатить · / }).click();
  await expect(page.getByText(/карта \+ наличные/)).toBeVisible();

  const [order] = await api<{ total: number; payments: { method: string; amount: number }[] }[]>(page, "/orders?limit=1");
  expect(order.total).toBe(31500);
  expect(order.payments.map((p) => [p.method, p.amount]).sort()).toEqual([
    ["card", 20000],
    ["cash", 11500],
  ]);

  const after = await api<{ totalCashSales: number; totalCardSales: number }>(page, "/cash-shifts/current", "cashier");
  expect(after.totalCardSales - before.totalCardSales).toBe(20000);
  expect(after.totalCashSales - before.totalCashSales).toBe(11500);
});

test("on credit: a new customer pays part now, the rest goes to the debt and is paid back at the register", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByText("Азиза Р.").click();
  await pressPin(page, "1234");
  const openShift = page.getByRole("button", { name: "Открыть смену" });
  await expect(page.getByText(/Сканер готов|Открытие смены/).first()).toBeVisible();
  if (await openShift.isVisible()) {
    await page.getByRole("button", { name: "50К" }).click();
    await openShift.click();
  }
  const before = await api<{ totalDebtSales: number; totalDebtRepaidCash: number; totalCashSales: number }>(page, "/cash-shifts/current", "cashier");

  const scan = page.getByPlaceholder("Штрихкод, код или название товара");
  await scan.fill(`2*${MILK}`);
  await scan.press("Enter");
  await page.getByText("Хлеб «Нон» белый").first().click();
  await expect(page.getByText(/31\s500\s*сўм/).first()).toBeVisible();

  // F11 — «В долг»: клиента нет в списке — добавляем прямо отсюда.
  await page.keyboard.press("F11");
  await page.getByRole("button", { name: "Добавить клиента" }).click();
  const dialog = page.getByRole("dialog", { name: "Новый клиент" });
  await dialog.getByRole("textbox").first().fill("Алишер");
  await dialog.getByPlaceholder("90 123-45-67").first().fill("901234567");
  await dialog.getByRole("button", { name: "Сохранить и выбрать" }).click();
  await expect(page.getByText("Алишер").first()).toBeVisible();

  // Сейчас 11 500 наличными, остальное — в долг.
  await page.keyboard.type("11500");
  await page.getByRole("button", { name: /^Записать: / }).click();
  await expect(page.getByText(/в долг 20\s000/).first()).toBeVisible();

  const [order] = await api<{ total: number; customerName: string; payments: { method: string; amount: number }[] }[]>(page, "/orders?limit=1");
  expect(order.customerName).toBe("Алишер");
  expect(order.payments.map((p) => [p.method, p.amount]).sort()).toEqual([
    ["cash", 11500],
    ["debt", 20000],
  ]);
  const [customer] = await api<{ id: string; debtBalance: number }[]>(page, "/customers?search=1234567");
  expect(customer.debtBalance).toBe(20000);

  // Клиент принёс деньги: «Долги» → клиент → «Весь долг» наличными.
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Долги" }).click();
  await page.getByRole("option", { name: /Алишер/ }).click();
  await page.getByRole("button", { name: /^Принять / }).click();
  await expect(page.getByText(/принято 20\s000/)).toBeVisible();

  const [paid] = await api<{ debtBalance: number }[]>(page, "/customers?search=1234567");
  expect(paid.debtBalance).toBe(0);
  const after = await api<{ totalDebtSales: number; totalDebtRepaidCash: number; totalCashSales: number }>(page, "/cash-shifts/current", "cashier");
  expect(after.totalDebtSales - before.totalDebtSales).toBe(20000);
  expect(after.totalCashSales - before.totalCashSales).toBe(11500);
  expect(after.totalDebtRepaidCash - before.totalDebtRepaidCash).toBe(20000);
});

test("a shop receives goods by scanning: a known product gets stock, an unknown barcode becomes a product without a category", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("например, my-shop").fill("demo-market");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByText("Азиза Р.").click();
  await pressPin(page, "1234");
  const openShift = page.getByRole("button", { name: "Открыть смену" });
  await expect(page.getByText(/Сканер готов|Открытие смены/).first()).toBeVisible();
  if (await openShift.isVisible()) {
    await page.getByRole("button", { name: "50К" }).click();
    await openShift.click();
  }
  const [milkBefore] = await api<{ currentStock: number }[]>(page, `/products?search=${MILK}`);

  await page.getByRole("button", { name: "Приход" }).click();
  const scan = page.getByPlaceholder("Сканируйте штрихкод или введите название");
  await scan.fill(MILK);
  await scan.press("Enter");
  await expect(page.getByText("Молоко «Лактис» 3,2% 1 л")).toBeVisible();
  await page.getByLabel("Количество").fill("10");
  await page.getByLabel("Цена прихода (за ед.)").fill("9000");
  await page.getByRole("button", { name: "Добавить в приход" }).click();

  await scan.fill("4780099999990");
  await scan.press("Enter");
  await page.getByPlaceholder("Название нового товара").fill("Сок тестовый 1 л");
  await page.getByLabel("Количество").fill("5");
  await page.getByLabel("Цена прихода (за ед.)").fill("7000");
  await page.getByLabel(/Цена продажи/).fill("9000");
  await page.getByRole("button", { name: "Добавить в приход" }).click();
  await page.getByRole("button", { name: "Оформить приход" }).click();
  await expect(page.getByText("Приход оформлен")).toBeVisible();

  const [milkAfter] = await api<{ currentStock: number }[]>(page, `/products?search=${MILK}`);
  expect(milkAfter.currentStock).toBe(milkBefore.currentStock + 10);
  const [juice] = await api<{ name: string; barcode: string; categoryId: string | null; currentStock: number; price: number }[]>(page, "/products?search=4780099999990");
  expect(juice).toMatchObject({ name: "Сок тестовый 1 л", barcode: "4780099999990", categoryId: null, currentStock: 5, price: 9000 });
});
