import api from "../services/api";
import { catalogService, type Product } from "../services";
import { fetchNational } from "./national";

export interface BarcodeHit {
  /** Товар уже есть в магазине. */
  product?: Product;
  /** Нет в магазине — название из национального каталога или общей базы штрихкодов. */
  name?: string;
}

/**
 * Что за товар под этим штрихкодом: сначала свой каталог магазина, потом
 * национальный каталог Узбекистана и общая база штрихкодов — тот же путь,
 * что у «Сканера» на странице товаров.
 */
export async function lookupBarcode(code: string): Promise<BarcodeHit> {
  const own = await api
    .get("/products/lookup", { params: { code } })
    .then((r) => r.data.data as Product)
    .catch((error) => {
      if (error?.response?.status === 404) return null;
      throw error;
    });
  if (own) return { product: own };
  const answer = (await catalogService.lookup(code, await fetchNational(code))).data.data;
  return answer.found ? { name: answer.displayName ?? undefined } : {};
}
