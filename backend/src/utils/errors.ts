import { Response } from "express";
import { alerts, isBug, requestContext } from "./alerts.js";
import { Prisma } from "@prisma/client";
import { logger } from "./logger.js";
import { sendError } from "./response.js";

// Domain errors carry the HTTP status they should produce, so controllers no
// longer have to guess (and no longer answer 400 for "not found").
export class AppError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Не найдено") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Недостаточно прав") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Конфликт") {
    super(message, 409);
    this.name = "ConflictError";
  }
}

// A Prisma failure means the request reached the database with something we
// failed to validate. Its message embeds the query, the file path and the
// tenant id, so it is logged server-side and replaced with a short message for
// the client.
function describePrismaError(error: Prisma.PrismaClientKnownRequestError): string {
  switch (error.code) {
    case "P2002":
      return "Запись с такими данными уже существует";
    case "P2003":
      return "Связанная запись не найдена";
    case "P2025":
      return "Запись не найдена";
    default:
      return "Ошибка базы данных";
  }
}

export interface ClientError {
  status: number;
  message: string;
}

export function toClientError(error: unknown, fallbackStatus = 400): ClientError {
  if (error instanceof AppError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Нет свободного соединения, транзакция не уложилась, конфликт записи —
    // перегрузка, а не ошибка запроса: 503 (касса повторит), и владелец узнает.
    if (["P2024", "P2028", "P2034"].includes(error.code)) {
      return { status: 503, message: "Сервер занят — повторите через несколько секунд" };
    }
    return { status: error.code === "P2025" ? 404 : 400, message: describePrismaError(error) };
  }
  if (
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError
  ) {
    return { status: 400, message: "Некорректный запрос" };
  }
  if (error instanceof Error) {
    return { status: fallbackStatus, message: error.message };
  }
  return { status: fallbackStatus, message: "Внутренняя ошибка" };
}

// Single exit point for controller catch blocks: log the real error, answer
// with a safe one.
export function handleError(res: Response, error: unknown, fallbackStatus = 400): void {
  const { status, message } = toClientError(error, fallbackStatus);
  if (status >= 500 || !(error instanceof AppError)) {
    logger.error("Request failed", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
  }
  // Ошибка кода или сбой базы — владельцу в Telegram и Sentry; отказы по делу — нет.
  if (isBug(error, status)) alerts.report(error, requestContext(res.req as Parameters<typeof requestContext>[0], status));
  sendError(res, message, status);
}
