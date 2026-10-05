import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";
import { sendError } from "../utils/response.js";
import { alerts, requestContext } from "../utils/alerts.js";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err.name !== "ValidationError" && err.name !== "UnauthorizedError") {
    alerts.report(err, requestContext(req as Parameters<typeof requestContext>[0], 500));
  }

  if (err.name === "ValidationError") {
    sendError(res, err.message, 400);
    return;
  }

  if (err.name === "UnauthorizedError") {
    sendError(res, "Unauthorized", 401);
    return;
  }

  sendError(res, "Internal server error", 500);
}

export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, `Route ${req.method} ${req.path} not found`, 404);
}
