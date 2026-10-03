import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "../types";

vi.mock("./api", () => ({ default: { post: vi.fn(), get: vi.fn() } }));

import api from "./api";
import { resetOfflineDb } from "./offlineDb";
import { findInCatalog, listCatalog, loadCatalog, refreshCatalog, resetCatalog, searchCatalog, takeFromCatalog, type CachedCatalog } from "./offlineCatalog";

const get = api.get as unknown as ReturnType<typeof vi.fn>;

const p = (fields: Partial<Product>): Product => ({ id: fields.name!, tags: "[]", trackInventory: true, currentStock: 10, price: 1000, ...fields }) as Product;

const catalog: CachedCatalog = {
  tenantId: "t1",
  savedAt: 0,
  categories: [],
  products: [
    p({ name: "Молоко «Лактис» 3,2%", barcode: "4780000000014", sku: "M1", categoryId: "dairy" }),
    p({ name: "Кока-кола 1,5 л", barcode: "0012345678905", categoryId: "drinks" }),
    p({ name: "Хлеб «Нон»", sku: "104", tags: '["quick"]' }),
    p({ name: "Яблоки", sku: "4780000000014", saleUnit: "кг" }), // короткий код совпал с чужим штрихкодом
  ],
};

describe("каталог на планшете", () => {
  beforeEach(() => {
    resetCatalog();
    resetOfflineDb();
    get.mockReset();
    localStorage.setItem("pos-user", JSON.stringify({ tenantId: "t1" }));
  });

  it("находит товар по штрихкоду раньше, чем по короткому коду, — как сервер", () => {
    expect(findInCatalog(catalog, "4780000000014")?.name).toBe("Молоко «Лактис» 3,2%");
    expect(findInCatalog(catalog, "104")?.name).toBe("Хлеб «Нон»");
    expect(findInCatalog(catalog, "999")).toBeNull();
  });

  it("узнаёт штрихкод в обоих написаниях: 12 цифр UPC-A и 13 с нулём", () => {
    expect(findInCatalog(catalog, "012345678905")?.name).toBe("Кока-кола 1,5 л");
    expect(findInCatalog(catalog, "0012345678905")?.name).toBe("Кока-кола 1,5 л");
  });

  it("ищет по словам названия без учёта регистра, кириллицей", () => {
    expect(searchCatalog(catalog, "молоко лактис").map((x) => x.name)).toEqual(["Молоко «Лактис» 3,2%"]);
    expect(searchCatalog(catalog, "КОЛА").map((x) => x.name)).toEqual(["Кока-кола 1,5 л"]);
    expect(searchCatalog(catalog, "")).toEqual([]);
  });

  it("собирает плитки и быстрые кнопки по тем же правилам, что и сервер", () => {
    expect(listCatalog(catalog, { categoryId: "dairy" })).toHaveLength(1);
    expect(listCatalog(catalog, { weighted: true }).map((x) => x.name)).toEqual(["Яблоки"]);
    expect(listCatalog(catalog, { tag: "quick" }).map((x) => x.name)).toEqual(["Хлеб «Нон»"]);
    expect(listCatalog(catalog, { noBarcode: true, weighted: false }).map((x) => x.name)).toEqual(["Хлеб «Нон»"]);
  });

  it("скачивает весь каталог постранично и хранит его на планшете", async () => {
    get.mockImplementation((url: string, config?: { params?: { page?: number } }) => {
      if (url === "/categories") return Promise.resolve({ data: { data: [{ id: "dairy" }] } });
      const page = config?.params?.page ?? 1;
      return Promise.resolve({ data: { data: [p({ name: `Товар ${page}` })], pagination: { page, totalPages: 3 } } });
    });

    const saved = await refreshCatalog();
    expect(saved?.products.map((x) => x.name)).toEqual(["Товар 1", "Товар 2", "Товар 3"]);

    resetCatalog(); // как после перезагрузки страницы
    expect((await loadCatalog())?.products).toHaveLength(3);
  });

  it("без связи оставляет прежнюю копию", async () => {
    get.mockResolvedValueOnce({ data: { data: [p({ name: "Старый" })], pagination: { page: 1, totalPages: 1 } } }).mockResolvedValueOnce({ data: { data: [] } });
    await refreshCatalog();
    get.mockRejectedValue(new Error("Network Error"));

    expect((await refreshCatalog())?.products.map((x) => x.name)).toEqual(["Старый"]);
  });

  it("уменьшает остаток в копии после офлайн-продажи — касса не показывает проданное", async () => {
    get.mockResolvedValueOnce({ data: { data: [p({ name: "Вода", id: "w", currentStock: 5 })], pagination: { page: 1, totalPages: 1 } } }).mockResolvedValueOnce({ data: { data: [] } });
    await refreshCatalog();

    await takeFromCatalog([{ productId: "w", units: 2 }]);

    expect((await loadCatalog())?.products[0].currentStock).toBe(3);
  });
});
