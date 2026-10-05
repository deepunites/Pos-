import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { validate } from "../middleware/validate.js";
import { clientErrorLimiter } from "../middleware/rateLimiter.js";
import { alerts } from "../utils/alerts.js";

// Ошибки кассы и админки: браузер шлёт сюда необработанные исключения, сервер
// пересылает их в Telegram и Sentry — ключи остаются только у сервера. Вход не
// обязателен (ошибка бывает и на экране входа); есть токен — подпишем, кто.
const clientErrorSchema = z.object({
  source: z.enum(["terminal", "admin"]),
  name: z.string().max(100).optional(),
  message: z.string().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  release: z.string().max(40).optional(),
});

const router = Router();

router.post("/", clientErrorLimiter, validate(clientErrorSchema), (req, res) => {
  const body = req.body as z.infer<typeof clientErrorSchema>;
  let who: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const u = jwt.verify(header.slice(7), getEnv().JWT_SECRET) as { id: string; role: string; tenantId: string; email?: string };
      who = `${u.email ?? u.id} (${u.role}) · точка ${u.tenantId.slice(0, 8)}`;
    } catch {
      // просроченный токен — без подписи
    }
  }
  let where: string | undefined;
  try {
    where = body.url ? new URL(body.url).pathname : undefined;
  } catch {
    where = undefined;
  }
  alerts.report({ name: body.name ?? "Error", message: body.message, stack: body.stack }, {
    source: body.source,
    where,
    who,
    userAgent: req.headers["user-agent"]?.slice(0, 300),
    release: body.release,
  });
  res.status(204).end();
});

export default router;
