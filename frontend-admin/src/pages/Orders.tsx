import { useState } from "react";
import { Link } from "react-router-dom";
import { useOrders, useUpdateOrderStatus, useCancelOrder } from "../hooks/useOrders";
import Badge, { statusBadge } from "../components/Badge";
import OfflineBadges from "../components/OfflineBadges";
import LoadingSpinner from "../components/LoadingSpinner";
import EmptyState from "../components/EmptyState";
import SearchInput from "../components/SearchInput";
import ConfirmDialog from "../components/ConfirmDialog";
import Tabs from "../components/Tabs";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { ShoppingCart, Eye } from "lucide-react";
import { useMoney } from "../hooks/useMoney";

const statusTabs = [
  { value: "", label: "Все заказы" },
  { value: "pending", label: "Ожидают" },
  { value: "confirmed", label: "Подтверждены" },
  { value: "preparing", label: "Готовятся" },
  { value: "ready", label: "Готовы" },
  { value: "completed", label: "Завершены" },
  { value: "cancelled", label: "Отменены" },
];

// Где заказ на кухне — отдельно от оплаты (оплаченный заказ кафе ещё готовится).
const kitchenLabels: Record<string, string> = { new: "Кухня: новый", cooking: "Кухня: готовится", ready: "Кухня: на выдаче", served: "Выдан" };

const statusFlow: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready"],
  ready: ["served"],
  served: ["completed"],
};

export default function Orders() {
  const { money } = useMoney();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);

  const { data, isLoading } = useOrders({ status: status || undefined, search, limit: 50 });
  const updateStatus = useUpdateOrderStatus();
  const cancelOrder = useCancelOrder();

  const orders = data?.data || [];

  // Отмена — отдельный запрос (/cancel): он возвращает резерв на склад и
  // освобождает стол. Простая смена статуса этого не делала.
  const handleStatusChange = (orderId: string, newStatus: string) => {
    if (newStatus === "cancelled") {
      setCancelId(orderId);
      return;
    }
    updateStatus.mutate({ id: orderId, status: newStatus });
  };

  const handleCancel = () => {
    if (cancelId) {
      cancelOrder.mutate(cancelId, { onSuccess: () => setCancelId(null) });
    }
  };

  const nextStatusLabels: Record<string, string> = {
    confirmed: "Подтвердить",
    preparing: "Готовить",
    ready: "Готово",
    served: "Подан",
    completed: "Завершить",
    cancelled: "Отменить",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Заказы</h1>
          <p className="text-gray-500">Управление и отслеживание заказов</p>
        </div>
      </div>

      <Tabs label="Статус заказов" items={statusTabs} value={status} onChange={setStatus} />

      <SearchInput value={search} onChange={setSearch} placeholder="Поиск заказов..." className="w-full sm:w-80" />

      {isLoading ? (
        <LoadingSpinner />
      ) : orders.length === 0 ? (
        <div className="card">
          {status || search ? (
            <EmptyState
              compact
              icon={<ShoppingCart className="h-6 w-6" />}
              title={search ? `По запросу «${search}» заказов нет` : `«${statusTabs.find((t) => t.value === status)?.label}» — сейчас пусто`}
              action={
                <button onClick={() => { setStatus(""); setSearch(""); }} className="btn-secondary">
                  Показать все заказы
                </button>
              }
            />
          ) : (
            <EmptyState
              compact
              icon={<ShoppingCart className="h-6 w-6" />}
              title="Заказов пока нет"
              description="Сюда попадает каждый чек с кассы. Чтобы касса заработала, откройте её на планшете и введите код точки."
              action={
                <Link to="/settings" className="btn-primary">
                  Код точки для кассы
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const badge = statusBadge(order.status);
            const nextStatuses = statusFlow[order.status] || [];
            return (
              <div key={order.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex min-w-[14rem] flex-1 items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-50 text-lg font-bold text-primary-700">
                    №{order.orderNumber}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-gray-900">{order.customerName || "Гость"}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {order.kitchenStatus && (
                        <Badge variant={order.kitchenStatus === "served" ? "gray" : "info"}>{kitchenLabels[order.kitchenStatus]}</Badge>
                      )}
                      <Badge variant="gray">{order.type === "dine_in" ? "Зал" : order.type === "takeaway" ? "Навынос" : order.type}</Badge>
                      <OfflineBadges order={order} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-gray-500">
                      <span>{order.items?.length || 0} поз.</span>
                      <span>·</span>
                      <span className="font-medium text-gray-900">{money(order.total)}</span>
                      {order.table && (<><span>·</span><span>Стол {order.table.number}</span></>)}
                      <span>·</span>
                      <span>{format(new Date(order.createdAt), "HH:mm", { locale: ru })}</span>
                    </div>
                  </div>
                </div>

                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {nextStatuses.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(order.id, s)}
                      className={`rounded-md px-3 py-2 text-sm font-medium transition-colors sm:py-1.5 sm:text-xs ${
                        s === "cancelled" ? "bg-danger-50 text-danger-700 hover:bg-danger-100" : "bg-primary-50 text-primary-700 hover:bg-primary-100"
                      }`}
                    >
                      {nextStatusLabels[s] || s}
                    </button>
                  ))}
                  <Link to={`/orders/${order.id}`} aria-label={`Открыть заказ №${order.orderNumber}`} className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600">
                    <Eye className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!cancelId}
        danger
        title="Отменить заказ?"
        description="Товар из заказа вернётся на склад, стол освободится. Отменённый заказ не восстановить."
        confirmLabel="Отменить заказ"
        cancelLabel="Не отменять"
        loading={cancelOrder.isPending}
        onConfirm={handleCancel}
        onCancel={() => setCancelId(null)}
      />
    </div>
  );
}
