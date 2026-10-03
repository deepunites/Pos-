import type { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import { ci } from "../../utils/search.js";
import type { CreateOrderInput, CheckoutInput, UpdateOrderStatusInput, OrderQueryInput, KitchenStatusInput } from "./order.schema.js";
import { Server as SocketIOServer } from "socket.io";
import {
  deductTechCardIngredients,
  gramsPerUnit,
  hasEnough,
  lockStockRows,
  recipeFor,
  releaseStock,
  reserveStock,
  round2,
  roundStock,
  stockUnitLabel,
  stockUnitsFor,
  type Reservation,
  type Tx,
} from "../inventory/stock.helpers.js";
import { optionalDateFilter, tenantTimeZone } from "../../utils/dates.js";
import { AppError, ConflictError, NotFoundError } from "../../utils/errors.js";
import { inTransaction } from "../../utils/transaction.js";
import { attachIdempotencyResource, claimIdempotencyKey, type IdempotencyContext } from "../../utils/idempotency.js";
import { lockOrder } from "./order.locks.js";

// Сколько часов заказ может висеть на экране кухни, пока его не выдали.
export const KITCHEN_WINDOW_HOURS = 12;

// The offline part of a checkout (checkoutSchema.offline).
export interface OfflineSale {
  soldAt: Date;
  cashierId?: string;
}

export class OrderTotalChangedError extends Error {
  constructor(public readonly actualTotal: number) {
    super("Сумма заказа изменилась — цены обновлены, проверьте корзину");
    this.name = "OrderTotalChangedError";
  }
}

let io: SocketIOServer;

export function setSocketIO(socketIO: SocketIOServer) {
  io = socketIO;
}

export class OrderService {
  async findAll(tenantId: string, query: OrderQueryInput) {
    const { status, type, branchId, tableId, dateFrom, dateTo, search, sort = "createdAt", order = "desc", page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = { tenantId };
    if (status) where.status = status;
    if (type) where.type = type;
    if (branchId) where.branchId = branchId;
    if (tableId) where.tableId = tableId;
    const createdAt = optionalDateFilter(dateFrom, dateTo, await tenantTimeZone(tenantId));
    if (createdAt) where.createdAt = createdAt;
    if (search) {
      where.OR = [
        { customerName: ci(search) },
        { customerPhone: { contains: search } },
      ];
    }

    const orderBy = { [sort]: order } as Prisma.OrderOrderByWithRelationInput;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, imageUrl: true } },
              modifiers: { include: { modifierItem: true } },
            },
          },
          user: { select: { id: true, firstName: true, lastName: true } },
          table: { select: { id: true, number: true } },
          payments: { select: { id: true, method: true, amount: true, status: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, total, page, limit };
  }

  async findById(tenantId: string, id: string) {
    const order = await prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          include: {
            product: true,
            modifiers: { include: { modifierItem: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true } },
        table: true,
        branch: { select: { id: true, name: true } },
        payments: true,
        receipts: true,
      },
    });
    if (!order) throw new NotFoundError("Заказ не найден");
    return order;
  }


  private readonly orderInclude = {
    items: {
      include: {
        product: { select: { id: true, name: true, imageUrl: true } },
        modifiers: { include: { modifierItem: true } },
      },
    },
    user: { select: { id: true, firstName: true, lastName: true } },
    table: { select: { id: true, number: true } },
    payments: true,
  } as const;

  // Prices every line from the current product record (never from the client),
  // builds the nested-create payload and the list of stock reservations.
  // An offline sale (see checkoutSchema.offline) is the exception: the money is
  // already taken, so each line keeps the price the customer paid, a product
  // taken off sale since is still accepted, and a short balance is not refused
  // here — reserveStock lets it go below zero and the order is marked.
  private async priceItems(tx: Tx, tenantId: string, items: CreateOrderInput["items"], offline = false) {
    let subtotal = 0;
    let priceChanged = false;
    const orderItems: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];
    const reserved = new Map<string, Reservation>();

    for (const item of items) {
      const product = await tx.product.findFirst({
        where: { id: item.productId, tenantId, ...(offline ? {} : { isActive: true }) },
      });
      if (!product) throw new NotFoundError(`Товар ${item.productId} не найден`);

      // Price is per gram or per kilogram depending on the sale unit; the cart
      // always states the weight in grams.
      const perUnit = gramsPerUnit(product.saleUnit);
      const isWeighted = perUnit !== null;
      if (isWeighted && !item.grams) {
        throw new Error(`Для весового товара «${product.name}» не указан вес`);
      }
      const weightGrams = isWeighted ? item.grams! : null;
      const serverPrice = isWeighted ? round2((product.price * weightGrams!) / perUnit!) : product.price;
      let unitPrice = serverPrice;
      if (offline && item.unitPrice !== undefined) {
        unitPrice = round2(item.unitPrice);
        if (Math.abs(unitPrice - serverPrice) > 0.005) priceChanged = true;
      }

      let itemTotal = unitPrice * item.quantity;

      const modifierItems: { modifierItemId: string; price: number }[] = [];
      if (item.modifierIds?.length) {
        // Only modifiers that belong to a group attached to this product may
        // be applied — otherwise any modifier id (including another shop's)
        // would be accepted and priced.
        const modifiers = await tx.modifierItem.findMany({
          where: {
            id: { in: item.modifierIds },
            isActive: true,
            modifierGroup: { products: { some: { productId: product.id } } },
          },
        });
        if (modifiers.length !== item.modifierIds.length) {
          throw new AppError(`Недопустимый модификатор для «${product.name}»`);
        }
        for (const mod of modifiers) {
          itemTotal += mod.price * item.quantity;
          modifierItems.push({ modifierItemId: mod.id, price: mod.price });
        }
      }
      itemTotal = round2(itemTotal);
      subtotal += itemTotal;

      if (product.trackInventory) {
        const units = stockUnitsFor({ quantity: item.quantity, weightGrams }, product.saleUnit);
        const prev = reserved.get(product.id);
        reserved.set(product.id, { productId: product.id, name: product.name, units: (prev?.units || 0) + units });
        // Early, friendlier check; the authoritative one happens in reserveStock.
        if (!offline && !hasEnough(product.currentStock, reserved.get(product.id)!.units)) {
          throw new Error(`Недостаточно товара «${product.name}» на складе: осталось ${roundStock(product.currentStock)}${stockUnitLabel(product.saleUnit)}`);
        }
      }

      orderItems.push({
        productId: item.productId,
        quantity: item.quantity,
        weightGrams,
        unitPrice,
        totalPrice: itemTotal,
        notes: item.notes,
        modifiers: { create: modifierItems },
      });
    }

    return { orderItems, subtotal: round2(subtotal), reservations: Array.from(reserved.values()), priceChanged };
  }

  // Creates the order row, then reserves stock against it — all on the caller's
  // transaction. The order number comes from the per-tenant counter
  // (nextOrderNumber), so two orders created at the same instant can't share one.
  private async createOrderInTx(tx: Tx, tenantId: string, userId: string, data: CreateOrderInput, status: string, offline?: OfflineSale) {
    // Referenced rows must belong to the caller's tenant.
    if (data.tableId) {
      const table = await tx.table.findFirst({ where: { id: data.tableId, tenantId } });
      if (!table) throw new NotFoundError("Стол не найден");
    }
    if (data.branchId) {
      const branch = await tx.branch.findFirst({ where: { id: data.branchId, tenantId } });
      if (!branch) throw new NotFoundError("Филиал не найден");
    }
    if (data.cashShiftId) {
      // Офлайн-чек принадлежит смене, в которую его пробили, даже если её уже закрыли.
      const shift = await tx.cashShift.findFirst({ where: { id: data.cashShiftId, tenantId, ...(offline ? {} : { status: "open" }) } });
      if (!shift) throw new NotFoundError(offline ? "Смена не найдена" : "Открытая смена не найдена");
    }
    let sellerId = userId;
    if (offline?.cashierId) {
      const cashier = await tx.user.findFirst({ where: { id: offline.cashierId, tenantId }, select: { id: true } });
      if (!cashier) throw new NotFoundError("Кассир не найден");
      sellerId = cashier.id;
    }
    const at = offline ? offline.soldAt : new Date();

    const { orderItems, subtotal, reservations, priceChanged } = await this.priceItems(tx, tenantId, data.items, Boolean(offline));
    const discountAmount = Math.min(data.discountAmount || 0, subtotal);
    const total = round2(subtotal - discountAmount);

    const orderNumber = await nextOrderNumber(tx, tenantId);
    // Заказ кафе сразу встаёт на экран кухни — и оплаченный тоже: статус оплаты
    // и кухни разные (schema.prisma, Order.kitchenStatus). Магазину кухня не нужна.
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { businessType: true } });
    const toKitchen = tenant?.businessType !== "retail";

    // Продажа на кассе (status "completed") в той же транзакции списывает
    // ингредиенты по техкарте. Товары и ингредиенты блокируются здесь разом,
    // одним отсортированным списком: если бы сначала брались товары, а потом
    // ингредиенты, две продажи, у которых товар одной — ингредиент другой,
    // могли бы ждать друг друга. Дальнейшие блокировки тех же строк в
    // reserveStock и deductTechCardIngredients мгновенны.
    if (status === "completed" && reservations.length > 0) {
      const recipes = await tx.product.findMany({
        where: { id: { in: data.items.map((i) => i.productId) }, tenantId },
        select: { techCard: true, techCardRef: { select: { ingredients: true } } },
      });
      await lockStockRows(tx, tenantId, [
        ...reservations.map((r) => r.productId),
        ...recipes.flatMap((p) => recipeFor(p).map((line) => line.ingredientId)),
      ]);
    }

    const created = await tx.order.create({
      data: {
        tenantId,
        userId: sellerId,
        branchId: data.branchId,
        tableId: data.tableId,
        cashShiftId: data.cashShiftId,
        orderNumber,
        status,
        type: data.type,
        subtotal,
        taxAmount: 0,
        discountAmount,
        total,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        notes: data.notes,
        completedAt: status === "completed" ? at : null,
        kitchenStatus: toKitchen ? "new" : null,
        kitchenStatusAt: toKitchen ? at : null,
        items: { create: orderItems },
        ...(offline ? { createdAt: at, offlineAt: at, offlinePriceChanged: priceChanged } : {}),
      },
    });

    const shortfall = await reserveStock(tx, { tenantId, userId: sellerId, orderId: created.id, reservations, allowNegative: Boolean(offline) });
    if (shortfall) {
      return tx.order.update({ where: { id: created.id }, data: { offlineShortfall: true } });
    }
    return created;
  }

  async create(tenantId: string, userId: string, data: CreateOrderInput, idem?: IdempotencyContext | null) {
    const created = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const row = await this.createOrderInTx(tx, tenantId, userId, data, "pending");
      if (data.tableId) {
        await tx.table.update({ where: { id: data.tableId }, data: { status: "occupied" } });
      }
      await attachIdempotencyResource(tx, tenantId, idem, row.id);
      return row;
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: this.orderInclude });

    if (io) {
      io.to(`tenant:${tenantId}`).emit("order:created", order);
      io.to(`tenant:${tenantId}:kitchen`).emit("order:new", order);
    }

    return order;
  }

  // Terminal sale: order, stock reservation, recipe write-off and the payment in
  // one transaction. Rejects with OrderTotalChangedError when the server total
  // differs from what the cashier collected, so the terminal can re-price the
  // cart instead of recording an underpaid "completed" sale.
  async checkout(tenantId: string, userId: string, data: CheckoutInput, idem?: IdempotencyContext | null) {
    const created = await inTransaction(async (tx) => {
      await claimIdempotencyKey(tx, tenantId, idem);
      const row = await this.createOrderInTx(tx, tenantId, userId, data, "completed", data.offline);

      if (Math.abs(row.total - data.expectedTotal) > 0.01) {
        // Офлайн-чек посчитан по ценам самой кассы — расхождение значит, что
        // строки и итог в запросе не сходятся, а не что цены изменились.
        if (data.offline) throw new AppError("Сумма офлайн-чека не сходится с его строками");
        throw new OrderTotalChangedError(row.total);
      }

      // Части оплаты («Карта + наличные») — каждая своей записью: смена и
      // отчёты считают деньги по способам. Вместе они — ровно итог чека.
      const processedAt = data.offline ? data.offline.soldAt : new Date();
      if (data.payments) {
        const paid = round2(data.payments.reduce((sum, part) => sum + part.amount, 0));
        if (Math.abs(paid - row.total) > 0.01) {
          throw new AppError(`Части оплаты (${paid}) не сходятся с итогом чека (${row.total})`);
        }
        for (const part of data.payments) {
          await tx.payment.create({
            data: { tenantId, orderId: row.id, method: part.method, amount: round2(part.amount), status: "completed", processedAt },
          });
        }
      } else {
        const payment = data.payment!;
        await tx.payment.create({
          data: {
            tenantId,
            orderId: row.id,
            method: payment.method,
            amount: row.total,
            tipAmount: payment.tipAmount || 0,
            transactionId: payment.transactionId,
            cardLastFour: payment.cardLastFour,
            status: "completed",
            processedAt,
          },
        });
      }

      await deductTechCardIngredients(tx, { tenantId, userId: row.userId ?? userId, orderId: row.id });
      await attachIdempotencyResource(tx, tenantId, idem, row.id);

      return row;
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: this.orderInclude });

    if (io) {
      io.to(`tenant:${tenantId}`).emit("order:created", order);
      io.to(`tenant:${tenantId}:kitchen`).emit("order:new", order);
    }

    return order;
  }

  async updateStatus(tenantId: string, id: string, data: UpdateOrderStatusInput) {
    // Под блокировкой строки заказа: смена статуса, отмена, оплата и фоновая
    // отмена неоплаченных заказов идут по очереди и видят состояние друг друга.
    const updated = await inTransaction(async (tx) => {
      const order = await lockOrder(tx, tenantId, id);
      if (!order) throw new NotFoundError("Заказ не найден");

      const updateData: Prisma.OrderUpdateInput = { status: data.status };
      if (data.status === "completed") updateData.completedAt = new Date();

      const row = await tx.order.update({
        where: { id },
        data: updateData,
        include: {
          items: { include: { product: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
          table: true,
        },
      });

      if (data.status === "completed" && order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data: { status: "available" },
        });
      }
      return row;
    });

    if (io) {
      io.to(`tenant:${tenantId}`).emit("order:updated", updated);
    }

    return updated;
  }


  async cancel(tenantId: string, id: string, userId: string) {
    // Статус проверяется под блокировкой строки заказа и в той же транзакции,
    // что и возврат остатка. Раньше проверка шла до транзакции: отмена,
    // совпавшая по времени с оплатой или с другой отменой, возвращала резерв
    // на склад дважды или отменяла уже оплаченный заказ.
    const updated = await inTransaction(async (tx) => {
      const locked = await lockOrder(tx, tenantId, id);
      if (!locked) throw new NotFoundError("Заказ не найден");
      if (["completed", "cancelled"].includes(locked.status)) {
        throw new ConflictError("Этот заказ нельзя отменить");
      }

      const items = await tx.orderItem.findMany({ where: { orderId: id }, include: { product: true } });
      const reservations: Reservation[] = items
        .filter((item) => item.product.trackInventory)
        .map((item) => ({ productId: item.productId, name: item.product.name, units: stockUnitsFor(item, item.product.saleUnit) }));

      await releaseStock(tx, { tenantId, userId, orderId: id, reservations });
      const row = await tx.order.update({
        where: { id },
        // Отменённый заказ готовить не нужно — с экрана кухни он уходит.
        data: { status: "cancelled", kitchenStatus: null, kitchenStatusAt: new Date() },
      });

      if (locked.tableId) {
        await tx.table.update({
          where: { id: locked.tableId },
          data: { status: "available" },
        });
      }
      return row;
    });

    if (io) {
      io.to(`tenant:${tenantId}`).emit("order:cancelled", updated);
    }

    return updated;
  }

  /**
   * Экран кухни: заказы, которые ещё не выданы. Окно — последние 12 часов,
   * чтобы забытая с вечера карточка не висела на экране вечно.
   */
  async getKitchenOrders(tenantId: string, branchId?: string) {
    const since = new Date(Date.now() - KITCHEN_WINDOW_HOURS * 60 * 60 * 1000);
    const where: Prisma.OrderWhereInput = {
      tenantId,
      kitchenStatus: { in: ["new", "cooking", "ready"] },
      createdAt: { gte: since },
    };
    if (branchId) where.branchId = branchId;
    return prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
            modifiers: { include: { modifierItem: true } },
          },
        },
        table: { select: { id: true, number: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async updateKitchenStatus(tenantId: string, id: string, data: KitchenStatusInput) {
    const found = await prisma.order.findFirst({ where: { id, tenantId }, select: { id: true, kitchenStatus: true } });
    if (!found) throw new NotFoundError("Заказ не найден");
    // null — заказ кухне не передавался (магазин) или отменён.
    if (found.kitchenStatus === null) throw new ConflictError("Этого заказа нет на кухне");

    const updated = await prisma.order.update({
      where: { id },
      data: { kitchenStatus: data.status, kitchenStatusAt: new Date() },
      select: { id: true, orderNumber: true, kitchenStatus: true, kitchenStatusAt: true },
    });
    if (io) io.to(`tenant:${tenantId}`).emit("order:kitchen", updated);
    return updated;
  }

  async getActiveOrders(tenantId: string, branchId?: string) {
    const where: Prisma.OrderWhereInput = {
      tenantId,
      status: { in: ["pending", "confirmed", "preparing", "ready", "served"] },
    };
    if (branchId) where.branchId = branchId;

    return prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
            modifiers: { include: { modifierItem: true } },
          },
        },
        user: { select: { id: true, firstName: true } },
        table: { select: { id: true, number: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }
}

export const orderService = new OrderService();

// Номер следующего заказа точки. Один INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING: строка счётчика остаётся заблокированной до конца транзакции,
// поэтому две одновременные продажи получают разные номера, а откат продажи
// возвращает номер — пропусков нет. Если строки счётчика ещё нет (новая точка
// или база, перенесённая из SQLite без счётчиков), она создаётся от текущего
// максимума номеров; одновременная первая вставка ждёт на первичном ключе и
// уходит в ветку DO UPDATE.
async function nextOrderNumber(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO order_counters (tenant_id, last_number)
    VALUES (${tenantId}, (SELECT COALESCE(MAX(order_number), 0) + 1 FROM orders WHERE tenant_id = ${tenantId}))
    ON CONFLICT (tenant_id) DO UPDATE SET last_number = order_counters.last_number + 1
    RETURNING last_number`;
  return row.last_number;
}
