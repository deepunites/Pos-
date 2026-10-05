import { Request, Response } from "express";
import { requirePermission } from "../users/permissions.js";
import { orderService, OrderTotalChangedError } from "./order.service.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import { idempotencyFrom, withIdempotency } from "../../utils/idempotency.js";
import type { OrderQueryInput } from "./order.schema.js";

export class OrderController {
  async findAll(req: Request, res: Response) {
    try {
      const query = req.query as unknown as OrderQueryInput;
      const { orders, total, page, limit } = await orderService.findAll(req.user!.tenantId, query);
      sendPaginated(res, orders, total, page, limit);
    } catch (error) {
      handleError(res, error);
    }
  }

  async findById(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const order = await orderService.findById(req.user!.tenantId, id);
      sendSuccess(res, order);
    } catch (error) {
      handleError(res, error, 404);
    }
  }

  async create(req: Request, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      const idem = idempotencyFrom(req, "POST /orders");
      // Повтор с тем же Idempotency-Key отвечает тем, что создал первый запрос.
      const { value: order, replayed } = await withIdempotency(
        tenantId,
        idem,
        () => orderService.create(tenantId, req.user!.id, req.body, idem),
        (id) => orderService.findById(tenantId, id)
      );
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      sendCreated(res, order);
    } catch (error) {
      handleError(res, error);
    }
  }

  async checkout(req: Request, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      if (req.body.payments?.some((part: { method: string }) => part.method === "debt")) {
        await requirePermission(req.user!, "canSellOnDebt");
      }
      const idem = idempotencyFrom(req, "POST /orders/checkout");
      // Повтор с тем же Idempotency-Key отвечает тем, что создал первый запрос.
      const { value: order, replayed } = await withIdempotency(
        tenantId,
        idem,
        () => orderService.checkout(tenantId, req.user!.id, req.body, idem),
        (id) => orderService.findById(tenantId, id)
      );
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      sendCreated(res, order);
    } catch (error) {
      if (error instanceof OrderTotalChangedError) {
        res.status(409).json({ success: false, error: error.message, actualTotal: error.actualTotal });
        return;
      }
      handleError(res, error);
    }
  }

  async updateStatus(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const order = await orderService.updateStatus(req.user!.tenantId, id, req.body);
      sendSuccess(res, order);
    } catch (error) {
      handleError(res, error);
    }
  }

  async cancel(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const order = await orderService.cancel(req.user!.tenantId, id, req.user!.id);
      sendSuccess(res, order);
    } catch (error) {
      handleError(res, error);
    }
  }

  async getKitchen(req: Request, res: Response) {
    try {
      const branchId = req.query.branchId as string | undefined;
      const orders = await orderService.getKitchenOrders(req.user!.tenantId, branchId);
      sendSuccess(res, orders);
    } catch (error) {
      handleError(res, error);
    }
  }

  async updateKitchenStatus(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const order = await orderService.updateKitchenStatus(req.user!.tenantId, id, req.body);
      sendSuccess(res, order);
    } catch (error) {
      handleError(res, error);
    }
  }

  async getActive(req: Request, res: Response) {
    try {
      const branchId = req.query.branchId as string | undefined;
      const orders = await orderService.getActiveOrders(req.user!.tenantId, branchId);
      sendSuccess(res, orders);
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const orderController = new OrderController();
