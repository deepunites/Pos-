import prisma from "../../config/database.js";
import { formatMoney } from "../../utils/money.js";
import { formatStock, orderStatusLabel, tenantUnits } from "./notifications.format.js";

export const notificationsService = {
  async getNotifications(tenantId: string) {
    const [tenant, recentOrders, lowStockProducts] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true, settings: true } }),
      prisma.order.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
        },
      }),
      prisma.product.findMany({
        where: {
          tenantId,
          isActive: true,
          trackInventory: true,
          currentStock: { lte: 5 },
        },
        orderBy: { currentStock: "asc" },
        take: 10,
        select: {
          id: true,
          name: true,
          currentStock: true,
          unit: true,
          saleUnit: true,
          sku: true,
        },
      }),
    ]);

    const units = tenantUnits(tenant?.settings);

    const notifications = [
      ...recentOrders.map((o) => ({
        id: `order-${o.id}`,
        type: "order" as const,
        title: `Заказ №${o.orderNumber}`,
        message: `Статус: ${orderStatusLabel(o.status)}, сумма: ${formatMoney(o.total, tenant?.currency)}`,
        read: false,
        createdAt: o.createdAt,
      })),
      ...lowStockProducts.map((p) => ({
        id: `stock-${p.id}`,
        type: "stock" as const,
        title: `Низкий остаток: ${p.name}`,
        message: `Осталось ${formatStock(p, units)}${p.sku ? ` (SKU: ${p.sku})` : ""}`,
        read: false,
        createdAt: new Date(),
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      notifications,
      unreadCount: notifications.length,
    };
  },
};
