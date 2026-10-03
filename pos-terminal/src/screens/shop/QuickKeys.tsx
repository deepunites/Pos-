import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import api from "../../services/api";
import { listCatalog, loadCatalog } from "../../services/offlineCatalog";
import { isNoConnection } from "../../utils/apiError";
import type { Product } from "../../types";
import { emojiFor, productTitle, shelfPrice } from "./shopProduct";

interface QuickKeysProps {
  money: (amount: number) => string;
  onPick: (product: Product) => void;
  onOpenWeighed: () => void;
}

const BASE = { isActive: true, isIngredient: false, limit: 4 };

/**
 * One-tap keys for goods that have no barcode to scan — bread, a carrier bag.
 * The admin marks them with «Быстрая кнопка» in the product form; until they
 * do, the first goods without a barcode stand in.
 */
export function useQuickProducts() {
  return useQuery<Product[]>({
    queryKey: ["shop-quick"],
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const tagged = await api.get("/products", { params: { ...BASE, tag: "quick" } });
        if (tagged.data.data.length > 0) return tagged.data.data as Product[];
        const fallback = await api.get("/products", { params: { ...BASE, noBarcode: true, weighted: false } });
        return fallback.data.data as Product[];
      } catch (error) {
        // Без связи — те же кнопки из каталога на планшете (офлайн-режим).
        if (!isNoConnection(error)) throw error;
        const catalog = await loadCatalog();
        const tagged = listCatalog(catalog, { tag: "quick" });
        return (tagged.length > 0 ? tagged : listCatalog(catalog, { noBarcode: true, weighted: false })).slice(0, Number(BASE.limit) || 12);
      }
    },
  });
}

export default function QuickKeys({ money, onPick, onOpenWeighed }: QuickKeysProps) {
  const { data: products = [] } = useQuickProducts();

  return (
    <div className="sh-quick">
      <div className="sh-ql lbl">
        <span>Без штрихкода — одно касание</span>
      </div>
      <div className="sh-qk">
        {products.map((product) => (
          <button key={product.id} className="sh-k" onClick={() => onPick(product)}>
            <span className="e">{emojiFor(product)}</span>
            <span>
              <b>{productTitle(product)}</b>
              <small className="tab">{money(shelfPrice(product).amount)}</small>
            </span>
          </button>
        ))}
        <button className="sh-k more" onClick={onOpenWeighed}>
          <Scale className="i" />
          Весовые
        </button>
      </div>
    </div>
  );
}
