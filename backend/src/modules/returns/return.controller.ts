import { Request, Response } from "express";
import { requirePermission } from "../users/permissions.js";
import { returnService } from "./return.service.js";
import { sendSuccess } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import { idempotencyFrom, withIdempotency } from "../../utils/idempotency.js";

export class ReturnController {
  async sales(req: Request, res: Response) {
    try {
      await requirePermission(req.user!, "canRefund");
      sendSuccess(res, await returnService.findSales(req.user!.tenantId, req.query.q as string | undefined));
    } catch (error) {
      handleError(res, error);
    }
  }

  async create(req: Request, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      await requirePermission(req.user!, "canRefund");
      const idem = idempotencyFrom(req, "POST /returns");
      // Повтор с тем же Idempotency-Key не вернёт деньги второй раз.
      const { value, replayed } = await withIdempotency(
        tenantId,
        idem,
        () => returnService.create(tenantId, req.user!.id, req.body, idem),
        (id) => returnService.findById(tenantId, id)
      );
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      sendSuccess(res, value, `Возврат №${value.number} оформлен`, 201);
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const returnController = new ReturnController();
