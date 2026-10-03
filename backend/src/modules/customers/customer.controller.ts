import { Request, Response } from "express";
import { customerService } from "./customer.service.js";
import { sendCreated, sendSuccess } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import { idempotencyFrom, withIdempotency } from "../../utils/idempotency.js";

export class CustomerController {
  async list(req: Request, res: Response) {
    try {
      sendSuccess(res, await customerService.list(req.user!.tenantId, req.query));
    } catch (error) {
      handleError(res, error);
    }
  }

  async summary(req: Request, res: Response) {
    try {
      sendSuccess(res, await customerService.summary(req.user!.tenantId));
    } catch (error) {
      handleError(res, error);
    }
  }

  async findById(req: Request, res: Response) {
    try {
      sendSuccess(res, await customerService.findById(req.user!.tenantId, req.params.id as string));
    } catch (error) {
      handleError(res, error);
    }
  }

  async create(req: Request, res: Response) {
    try {
      sendCreated(res, await customerService.create(req.user!.tenantId, req.body));
    } catch (error) {
      handleError(res, error);
    }
  }

  async update(req: Request, res: Response) {
    try {
      sendSuccess(res, await customerService.update(req.user!.tenantId, req.params.id as string, req.body));
    } catch (error) {
      handleError(res, error);
    }
  }

  async repay(req: Request, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      const id = req.params.id as string;
      const idem = idempotencyFrom(req, `POST /customers/${id}/repayments`);
      // Повтор с тем же Idempotency-Key не списывает долг второй раз.
      const { value, replayed } = await withIdempotency(
        tenantId,
        idem,
        () => customerService.repay(tenantId, req.user!.id, id, req.body, idem),
        (entryId) => customerService.repaymentResult(tenantId, entryId)
      );
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      sendCreated(res, value);
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const customerController = new CustomerController();
