import { Request, Response } from "express";
import { requirePermission } from "../users/permissions.js";
import { nextInvoiceNumber, stockReceiptService } from "./stock-receipt.service.js";
import prisma from "../../config/database.js";
import { sendSuccess, sendPaginated } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import { idempotencyFrom, withIdempotency } from "../../utils/idempotency.js";

export class StockReceiptController {
  async create(req: Request, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      await requirePermission(req.user!, "canReceiveStock");
      const idem = idempotencyFrom(req, "POST /stock-receipts");
      // Повтор с тем же Idempotency-Key отвечает тем, что создал первый запрос.
      const { value: receipt, replayed } = await withIdempotency(
        tenantId,
        idem,
        () => stockReceiptService.create(tenantId, req.user!.id, req.body, idem),
        (id) => stockReceiptService.findById(tenantId, id)
      );
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      sendSuccess(res, receipt, "Приход создан", 201);
    } catch (error) {
      handleError(res, error);
    }
  }

  async findAll(req: Request, res: Response) {
    try {
      const { receipts, total, page, limit } = await stockReceiptService.findAll(req.user!.tenantId, {
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 20,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        supplierName: req.query.supplierName as string,
      });
      sendPaginated(res, receipts, total, page, limit);
    } catch (error) {
      handleError(res, error);
    }
  }

  /** Номер, который получит следующий приход, — форма показывает его заранее. */
  async nextNumber(req: Request, res: Response) {
    try {
      sendSuccess(res, { invoiceNumber: await nextInvoiceNumber(prisma, req.user!.tenantId) });
    } catch (error) {
      handleError(res, error);
    }
  }

  async findById(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const receipt = await stockReceiptService.findById(req.user!.tenantId, id);
      sendSuccess(res, receipt);
    } catch (error) {
      handleError(res, error, 404);
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      await stockReceiptService.delete(req.user!.tenantId, id, req.user!.id);
      sendSuccess(res, null, "Приход удалён");
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const stockReceiptController = new StockReceiptController();
