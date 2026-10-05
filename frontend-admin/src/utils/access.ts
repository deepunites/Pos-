/**
 * Кто и что видит в панели управления.
 *
 * Панель — рабочее место администратора и менеджера: себестоимость, маржа,
 * поставщики, зарплатные роли, смены всех кассиров. Повар заходит сюда ради
 * одной страницы «Кухня» — это его рабочий экран. Кассиру и официанту в
 * панели делать нечего: их место за кассой, и вход им закрыт.
 *
 * Проверка здесь — не защита данных, а навигация: данные закрывает бэкенд
 * (`authorize` на маршрутах). Эти две вещи должны меняться вместе.
 */

/** Роли с полным доступом к панели. */
const FULL_ACCESS = ["admin", "manager"];

/** Единственная страница, доступная повару. */
const KITCHEN_PATH = "/kitchen";

/** Витрина интерфейса (D-5) — инструмент разработки, только администратору. */
export const DESIGN_PATH = "/_design";

/**
 * Адрес кассы — куда отправлять тех, кому панель не положена.
 *
 * Выводим из текущего хоста (admin.qwik.uz → pos.qwik.uz), чтобы ссылка
 * работала и в проде, и на тестовом домене без отдельной настройки.
 * В локальной разработке хоста с префиксом нет — тогда порт терминала.
 */
export function posUrl(): string {
  if (typeof window === "undefined") return "https://pos.qwik.uz";
  const { protocol, hostname, host } = window.location;
  if (hostname.startsWith("admin.")) return `${protocol}//${hostname.replace(/^admin\./, "pos.")}`;
  if (hostname === "localhost" || hostname === "127.0.0.1") return `${protocol}//${hostname}:5174`;
  return `${protocol}//${host}`;
}

/** Пускать ли эту роль в панель вообще. */
export function canOpenPanel(role?: string | null): boolean {
  if (!role) return false;
  return FULL_ACCESS.includes(role) || role === "kitchen";
}

/** Доступна ли роли конкретная страница панели. */
export function canOpenPath(role: string | null | undefined, path: string): boolean {
  if (!role) return false;
  if (path === DESIGN_PATH) return role === "admin";
  if (FULL_ACCESS.includes(role)) return true;
  if (role === "kitchen") return path === KITCHEN_PATH;
  return false;
}

/**
 * Разделы кафе и ресторана. В магазине их нет в меню: рецептур, кухни и столов
 * там не бывает, а товар ищут сканером и поиском, не по категориям.
 */
const RESTAURANT_ONLY = ["/tech-cards", "/categories", "/kitchen", "/tables"];

export function isRestaurantOnly(path: string): boolean {
  return RESTAURANT_ONLY.includes(path);
}

/** Куда вести роль сразу после входа. */
export function homePathFor(role?: string | null): string {
  return role === "kitchen" ? KITCHEN_PATH : "/";
}

/**
 * Ошибка входа для роли, которой панель не положена.
 *
 * Текст короткий намеренно: к нему при показе добавляется сообщение о
 * переходе на кассу, и длинная фраза в тосте не помещается.
 */
export class PanelAccessError extends Error {
  constructor() {
    super("Эта панель — для администраторов и менеджеров.");
    this.name = "PanelAccessError";
  }
}
