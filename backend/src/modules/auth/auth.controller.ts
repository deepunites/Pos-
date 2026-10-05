import { Request, Response } from "express";
import { permissionsOf } from "../users/permissions.js";
import { authService } from "./auth.service.js";
import { sendSuccess } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const tenantId = req.headers["x-tenant-id"] as string | undefined;
      const result = await authService.login(req.body, tenantId);
      sendSuccess(res, result, "Login successful");
    } catch (error) {
      handleError(res, error, 401);
    }
  }

  async register(req: Request, res: Response) {
    try {
      const result = await authService.register(req.body);
      sendSuccess(res, result, "Registration successful", 201);
    } catch (error) {
      handleError(res, error, 400);
    }
  }

  async staff(req: Request, res: Response) {
    try {
      const data = await authService.staff(req.query.tenant as string);
      sendSuccess(res, data);
    } catch (error) {
      handleError(res, error, 404);
    }
  }

  async loginPin(req: Request, res: Response) {
    try {
      const { tenant, userId, pin } = req.body;
      const result = await authService.loginPin(tenant, userId, pin);
      sendSuccess(res, result, "Login successful");
    } catch (error) {
      handleError(res, error, 401);
    }
  }

  async refreshToken(req: Request, res: Response) {
    try {
      const result = await authService.refreshToken(req.body.refreshToken);
      sendSuccess(res, result, "Token refreshed");
    } catch (error) {
      handleError(res, error, 401);
    }
  }

  async changePassword(req: Request, res: Response) {
    try {
      const result = await authService.changePassword(
        req.user!.id,
        req.body.currentPassword,
        req.body.newPassword
      );
      sendSuccess(res, result);
    } catch (error) {
      handleError(res, error, 400);
    }
  }

  // Права — свежие из базы: касса спрашивает их, чтобы снятая администратором
  // галочка спрятала кнопку без перевхода кассира.
  async me(req: Request, res: Response) {
    try {
      sendSuccess(res, { ...req.user, permissions: await permissionsOf(req.user!) });
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const authController = new AuthController();
