import Badge from "./Badge";
import type { Order } from "../services";

type OfflineMarks = Pick<Order, "offlineAt" | "offlineShortfall" | "offlinePriceChanged">;

/**
 * Метки продажи, пробитой на кассе без связи (офлайн-режим магазина): чек
 * пришёл на сервер позже, по цене, которую взяли с покупателя, и склад мог
 * уйти в минус — такие продажи стоит просмотреть.
 */
export default function OfflineBadges({ order }: { order: OfflineMarks }) {
  if (!order.offlineAt) return null;
  return (
    <>
      <Badge variant="warning">Без связи</Badge>
      {order.offlineShortfall && <Badge variant="danger">Склад в минусе</Badge>}
      {order.offlinePriceChanged && <Badge variant="warning">Цена изменилась</Badge>}
    </>
  );
}

/** Пояснение к меткам — на странице заказа. */
export function OfflineNote({ order }: { order: OfflineMarks }) {
  if (!order.offlineAt) return null;
  return (
    <div className="rounded-md border border-warning-200 bg-warning-50 p-4 text-sm text-warning-800">
      <p className="font-medium">Продажа без связи</p>
      <p className="mt-1">Пробита на кассе, когда не было интернета, и отправлена, как только связь вернулась. Время заказа — время продажи на кассе.</p>
      {order.offlineShortfall && <p className="mt-1">На складе не хватало товара — остаток ушёл в минус. Проверьте приход.</p>}
      {order.offlinePriceChanged && <p className="mt-1">Цена в чеке отличается от цены в каталоге — оставлена та, по которой продали.</p>}
    </div>
  );
}
