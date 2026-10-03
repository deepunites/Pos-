import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useOrder } from "../hooks/useOrders";
import LoadingSpinner from "../components/LoadingSpinner";
import Badge, { statusBadge } from "../components/Badge";
import OfflineBadges, { OfflineNote } from "../components/OfflineBadges";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { useMoney } from "../hooks/useMoney";

export default function OrderDetail() {
  const { money } = useMoney();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: order, isLoading } = useOrder(id!);

  if (isLoading) return <LoadingSpinner />;
  if (!order) return <div className="text-center py-12 text-gray-500">Заказ не найден</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate("/orders")} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><ArrowLeft className="h-5 w-5" /></button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Заказ №{order.orderNumber}</h1>
          <p className="text-gray-500">{format(new Date(order.createdAt), "d MMMM yyyy HH:mm", { locale: ru })}</p>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <OfflineBadges order={order} />
          <Badge variant={statusBadge(order.status).variant}>{statusBadge(order.status).label}</Badge>
        </div>
      </div>

      <OfflineNote order={order} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card"><p className="text-xs text-gray-500">Клиент</p><p className="text-sm font-medium">{order.customerName || "Гость"}</p></div>
        <div className="card"><p className="text-xs text-gray-500">Тип</p><p className="text-sm font-medium capitalize">{order.type === "dine_in" ? "В зале" : order.type === "takeaway" ? "Навынос" : order.type}</p></div>
        <div className="card"><p className="text-xs text-gray-500">Стол</p><p className="text-sm font-medium">{order.table?.number || "—"}</p></div>
      </div>

      <div className="card">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Позиции</h2>
        <div className="space-y-3">
          {order.items?.map((item) => (
            <div key={item.id} className="flex items-center justify-between border-b border-gray-100 py-3 last:border-0">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-sm font-medium">{item.quantity}x</span>
                <div>
                  <p className="font-medium text-gray-900">
                    {item.product?.name}
                    {item.weightGrams ? <span className="ml-1 text-xs text-gray-500">({item.weightGrams} г)</span> : null}
                  </p>
                  {item.notes && <p className="text-xs text-gray-500">{item.notes}</p>}
                </div>
              </div>
              <span className="font-medium text-gray-900">{money(item.totalPrice)}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 border-t border-gray-200 pt-4 space-y-2">
          <div className="flex justify-between text-sm text-gray-500"><span>Подытог</span><span>{money(order.subtotal)}</span></div>
          {Number(order.taxAmount) > 0 && <div className="flex justify-between text-sm text-gray-500"><span>Налог</span><span>{money(order.taxAmount)}</span></div>}
          {Number(order.discountAmount) > 0 && <div className="flex justify-between text-sm text-success-600"><span>Скидка</span><span>-{money(order.discountAmount)}</span></div>}
          <div className="flex justify-between text-lg font-bold text-gray-900"><span>Итого</span><span>{money(order.total)}</span></div>
        </div>
      </div>

      {order.payments && order.payments.length > 0 && (
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Оплаты</h2>
          <div className="space-y-2">
            {order.payments.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                <div className="flex items-center gap-3">
                  <Badge variant={payment.status === "completed" ? "success" : payment.status === "refunded" ? "danger" : "warning"}>{payment.status === "completed" ? "Оплачено" : payment.status === "refunded" ? "Возврат" : payment.status}</Badge>
                  <span className="text-sm text-gray-600">{payment.method === "cash" ? "Наличные" : payment.method === "card" ? "Карта" : payment.method}</span>
                </div>
                <span className="font-medium">{money(payment.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {order.notes && (
        <div className="card"><h2 className="mb-2 text-lg font-semibold text-gray-900">Примечания</h2><p className="text-gray-600">{order.notes}</p></div>
      )}
    </div>
  );
}
