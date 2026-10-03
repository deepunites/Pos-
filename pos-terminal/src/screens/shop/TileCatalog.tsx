import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import api from "../../services/api";
import { listCatalog, loadCatalog } from "../../services/offlineCatalog";
import { isNoConnection } from "../../utils/apiError";
import type { CartItem, Category, Product } from "../../types";
import { formatKg } from "../../utils/weight";
import { emojiFor, productTitle, shelfPrice, stockLabel, stockState, weightUnit } from "./shopProduct";

export type TileFilter = "all" | "weighed" | string; // string — a category id

interface TileCatalogProps {
  filter: TileFilter;
  onFilter: (filter: TileFilter) => void;
  items: CartItem[];
  parts: (amount: number) => { figure: string; symbol: string; suffix: boolean };
  onPick: (product: Product) => void;
}

interface Page {
  data: Product[];
  pagination?: { page: number; totalPages: number };
}

const PAGE_SIZE = 48;

/** What the cart already holds of a product, as a tile badge: "×2" for pieces, "1,240 кг" for weight. */
function inCartLabel(productId: string, items: CartItem[]): string | null {
  const lines = items.filter((i) => i.productId === productId);
  if (lines.length === 0) return null;
  const grams = lines.reduce((sum, i) => sum + (i.grams ?? 0), 0);
  if (grams > 0) return `${formatKg(grams)} кг`;
  return `×${lines.reduce((sum, i) => sum + i.quantity, 0)}`;
}

/**
 * The tile catalogue (variant B inside the register): categories along the top,
 * goods as big tiles with price and stock. Pages come from the server, so a shop
 * with thousands of goods never loads them all.
 */
export default function TileCatalog({ filter, onFilter, items, parts, onPick }: TileCatalogProps) {
  const { data: categoriesAll } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      try {
        return (await api.get("/categories")).data.data;
      } catch (error) {
        if (isNoConnection(error)) return (await loadCatalog())?.categories ?? [];
        throw error;
      }
    },
  });
  const categories = (categoriesAll ?? []).filter((c) => !c.isIngredient && (c._count?.products ?? 1) > 0);

  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery<Page>({
    queryKey: ["shop-tiles", filter],
    initialPageParam: 1,
    staleTime: 15_000,
    queryFn: async ({ pageParam }) => {
      try {
        return (
          await api.get("/products", {
            params: {
              page: pageParam,
              limit: PAGE_SIZE,
              isActive: true,
              isIngredient: false,
              ...(filter === "weighed" ? { weighted: true } : filter !== "all" ? { categoryId: filter } : {}),
            },
          })
        ).data as Page;
      } catch (error) {
        // Без связи — плитки из каталога на планшете, одной страницей (офлайн-режим).
        if (!isNoConnection(error)) throw error;
        const data = listCatalog(await loadCatalog(), filter === "weighed" ? { weighted: true } : filter !== "all" ? { categoryId: filter } : {});
        return { data, pagination: { page: 1, limit: data.length, total: data.length, totalPages: 1 } } as Page;
      }
    },
    getNextPageParam: (last) => (last.pagination && last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined),
  });
  const products = data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <>
      <div className="sh-cats">
        <button className={`sh-cc${filter === "all" ? " on" : ""}`} onClick={() => onFilter("all")}>
          Все
        </button>
        <button className={`sh-cc${filter === "weighed" ? " on" : ""}`} onClick={() => onFilter("weighed")}>
          <Scale className="i" />
          Весовые
        </button>
        {categories.map((category) => (
          <button key={category.id} className={`sh-cc${filter === category.id ? " on" : ""}`} onClick={() => onFilter(category.id)}>
            {category.name}
            {category._count?.products !== undefined && <small className="tab">{category._count.products}</small>}
          </button>
        ))}
      </div>

      <div className="sh-tiles-wrap">
        {isLoading ? (
          <div className="sh-empty">
            <span className="sh-spin" />
          </div>
        ) : isError ? (
          <div className="sh-empty">
            <b>Не удалось загрузить товары</b>
            <small>Проверьте связь с сервером</small>
          </div>
        ) : products.length === 0 ? (
          <div className="sh-empty">
            <b>Здесь пока нет товаров</b>
            <small>Отсканируйте штрихкод — менеджеру касса предложит завести товар сразу. Или добавьте товары в панели управления.</small>
          </div>
        ) : (
          <>
            <div className="sh-tiles">
              {products.map((product) => {
                const price = shelfPrice(product);
                const state = stockState(product);
                const stock = stockLabel(product);
                const added = inCartLabel(product.id, items);
                const weighed = Boolean(weightUnit(product));
                return (
                  <button
                    key={product.id}
                    className={`sh-t${added ? " in" : ""}${state === "out" ? " off" : ""}`}
                    disabled={state === "out"}
                    onClick={() => onPick(product)}
                  >
                    {weighed && (
                      <span className="sh-bd l">
                        <Scale className="i" />
                        вес
                      </span>
                    )}
                    {added ? (
                      <span className="sh-bd r tab">{added}</span>
                    ) : state === "out" ? (
                      <span className="sh-bd r out">нет в наличии</span>
                    ) : state === "low" ? (
                      <span className="sh-bd r low tab">мало · {stock}</span>
                    ) : stock ? (
                      <span className="sh-bd r tab">ост. {stock}</span>
                    ) : null}
                    <div className="emo">{product.imageUrl ? <img src={product.imageUrl} alt="" /> : emojiFor(product)}</div>
                    <div className="nm">{productTitle(product)}</div>
                    <div className="pr">
                      <span className="v tab">{parts(price.amount).figure}</span>
                      <small>
                        {parts(price.amount).symbol}
                        {price.per && ` / ${price.per}`}
                      </small>
                    </div>
                  </button>
                );
              })}
            </div>
            {hasNextPage && (
              <button className="sh-more" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "Загружаем…" : "Показать ещё"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
