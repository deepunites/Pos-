import type { ShiftQueryInput } from "./cash-shift.schema.js";
import { Request, Response } from "express";
import { cashShiftService } from "./cash-shift.service.js";
import { sendSuccess, sendPaginated } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import { blindShift, permissionsOf } from "../users/permissions.js";

// «Слепое» закрытие: кассиру без права видеть сумму смены итоги и ожидаемая
// наличность не отдаются вовсе — спрятать их только на экране было бы мало.
async function forViewer<T extends object | null>(req: Request, shift: T): Promise<T> {
  return (await permissionsOf(req.user!)).canSeeExpectedCash ? shift : blindShift(shift);
}

export class CashShiftController {
  async openShift(req: Request, res: Response) {
    try {
      const shift = await cashShiftService.openShift(
        req.user!.tenantId,
        req.user!.id,
        req.body.openingCash,
        req.body.notes
      );
      sendSuccess(res, shift, "Смена открыта", 201);
    } catch (error) {
      handleError(res, error);
    }
  }

  async closeShift(req: Request, res: Response) {
    try {
      const shift = await cashShiftService.closeShift(
        req.user!.tenantId,
        req.params.id as string,
        req.user!.id,
        req.user!.role,
        req.body.closingCash,
        req.body.notes
      );
      sendSuccess(res, await forViewer(req, shift), "Смена закрыта");
    } catch (error) {
      handleError(res, error);
    }
  }

  async getCurrentShift(req: Request, res: Response) {
    try {
      const shift = await cashShiftService.getCurrentShift(
        req.user!.tenantId,
        req.user!.id
      );
      sendSuccess(res, await forViewer(req, shift));
    } catch (error) {
      handleError(res, error);
    }
  }

  async findAll(req: Request, res: Response) {
    try {
      const { shifts, total, page, limit } = await cashShiftService.findAll(
        req.user!.tenantId,
        {
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
          status: req.query.status as ShiftQueryInput["status"],
          userId: req.query.userId as string | undefined,
        }
      );
      sendPaginated(res, shifts, total, page, limit);
    } catch (error) {
      handleError(res, error);
    }
  }

  async findById(req: Request, res: Response) {
    try {
      const shift = await cashShiftService.findById(
        req.user!.tenantId,
        req.params.id as string
      );
      sendSuccess(res, await forViewer(req, shift));
    } catch (error) {
      handleError(res, error, 404);
    }
  }
}

export const cashShiftController = new CashShiftController();
