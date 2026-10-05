import prisma from "../../config/database.js";
import { returnService } from "../returns/return.service.js";
import {
  addDays,
  dateRange,
  firstOfMonthInZone,
  hourInZone,
  tenantTimeZone,
  todayInZone,
  zonedDayStart,
} from "../../utils/dates.js";

export class ReportService {
  async getDashboard(tenantId: string) {
    const tz = await tenantTimeZone(tenantId);
    const today = todayInZone(tz);
    const todayStart = zonedDayStart(today, tz);
    const weekStart = zonedDayStart(addDays(today, -6), tz);
    const monthStart = zonedDayStart(firstOfMonthInZone(tz), tz);

    const [
      todayOrders,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      activeOrders,
      totalProducts,
      lowStockProducts,
      recentOrders,
    ] = await Promise.all([
      prisma.order.count({
        where: { tenantId, createdAt: { gte: todayStart }, status: { not: "cancelled" } },
      }),
      prisma.payment.aggregate({
        where: { tenantId, status: "completed", createdAt: { gte: todayStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { tenantId, status: "completed", createdAt: { gte: weekStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { tenantId, status: "completed", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.order.count({
        where: { tenantId, status: { in: ["pending", "confirmed", "preparing", "ready", "served"] } },
      }),
      prisma.product.count({ where: { tenantId, isActive: true } }),
      // «Мало на складе» — остаток не выше минимального, как в
      // inventory.getLowStockAlerts. Раньше здесь считались все товары с
      // учётом остатка, и на дашборде стояло их общее число.
      prisma.product.count({
        where: { tenantId, trackInventory: true, isActive: true, currentStock: { lte: prisma.product.fields.minStock } },
      }),
      prisma.order.findMany({
        where: { tenantId },
        include: {
          items: { select: { quantity: true, totalPrice: true } },
          user: { select: { firstName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // Выручка — за вычетом возвратов товара за тот же период.
    const [todayReturns, weekReturns, monthReturns] = await Promise.all([
      returnService.sumSince(tenantId, todayStart),
      returnService.sumSince(tenantId, weekStart),
      returnService.sumSince(tenantId, monthStart),
    ]);

    return {
      todayOrders,
      todayRevenue: (todayRevenue._sum.amount || 0) - todayReturns,
      weekRevenue: (weekRevenue._sum.amount || 0) - weekReturns,
      monthRevenue: (monthRevenue._sum.amount || 0) - monthReturns,
      activeOrders,
      totalProducts,
      lowStockProducts,
      recentOrders,
    };
  }

  async getSalesReport(tenantId: string, dateFrom: string, dateTo: string) {
    const tz = await tenantTimeZone(tenantId);
    const { start, end } = dateRange(dateFrom, dateTo, tz);

    const [revenue, orders, topProducts, rawSalesByHour] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          tenantId,
          status: "completed",
          createdAt: { gte: start, lt: end },
        },
        _sum: { amount: true, tipAmount: true },
        _count: true,
      }),
      prisma.order.groupBy({
        by: ["type"],
        where: {
          tenantId,
          createdAt: { gte: start, lt: end },
          status: { not: "cancelled" },
        },
        _count: true,
        _sum: { total: true },
      }),
      prisma.orderItem.groupBy({
        by: ["productId"],
        where: {
          order: { tenantId, createdAt: { gte: start, lt: end }, status: { not: "cancelled" } },
        },
        _sum: { quantity: true, totalPrice: true },
        _count: true,
        orderBy: { _sum: { totalPrice: "desc" } },
        take: 10,
      }),
      prisma.order.findMany({
        where: {
          tenantId,
          createdAt: { gte: start, lt: end },
          status: { not: "cancelled" },
        },
        select: { createdAt: true, total: true },
      }),
    ]);

    const hourMap = new Map<string, { order_count: number; revenue: number }>();
    for (const o of rawSalesByHour) {
      const hour = hourInZone(o.createdAt, tz);
      const existing = hourMap.get(hour) || { order_count: 0, revenue: 0 };
      existing.order_count += 1;
      existing.revenue += o.total;
      hourMap.set(hour, existing);
    }
    const salesByHour = Array.from(hourMap.entries())
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    const totalReturns = await returnService.sumSince(tenantId, start, end);

    return {
      totalRevenue: (revenue._sum.amount || 0) - totalReturns,
      totalReturns,
      totalTips: revenue._sum.tipAmount || 0,
      totalTransactions: revenue._count,
      ordersByType: orders,
      topProducts,
      salesByHour,
    };
  }

  async getEmployeeReport(tenantId: string, dateFrom: string, dateTo: string) {
    const tz = await tenantTimeZone(tenantId);
    const { start, end } = dateRange(dateFrom, dateTo, tz);

    const employees = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      include: {
        orders: {
          where: { createdAt: { gte: start, lt: end }, status: { not: "cancelled" } },
          select: { total: true, createdAt: true },
        },
      },
    });

    return employees.map((emp) => ({
      id: emp.id,
      name: `${emp.firstName} ${emp.lastName}`,
      role: emp.role,
      ordersCount: emp.orders.length,
      totalSales: emp.orders.reduce((sum, o) => sum + o.total, 0),
    }));
  }
}

export const reportService = new ReportService();
