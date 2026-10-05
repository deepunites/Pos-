import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

import { getEnv } from "./config/env.js";
import prisma from "./config/database.js";
import { initSocketIO } from "./modules/orders/order.gateway.js";
import { startStaleOrderSweeper } from "./modules/orders/order.cleanup.js";
import { setSocketIO } from "./modules/orders/order.service.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { alerts } from "./utils/alerts.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import { logger } from "./utils/logger.js";

// Routes
import authRoutes from "./api/auth.routes.js";
import productRoutes from "./api/products.routes.js";
import orderRoutes from "./api/orders.routes.js";
import paymentRoutes from "./api/payments.routes.js";
import userRoutes from "./api/users.routes.js";
import categoryRoutes from "./api/categories.routes.js";
import inventoryRoutes from "./api/inventory.routes.js";
import reportRoutes from "./api/reports.routes.js";
import tableRoutes from "./api/tables.routes.js";
import settingsRoutes from "./api/settings.routes.js";
import notificationsRoutes from "./api/notifications.routes.js";
import receiptRoutes from "./api/receipts.routes.js";
import auditRoutes from "./api/audit.routes.js";
import stockReceiptRoutes from "./api/stock-receipts.routes.js";
import returnRoutes from "./api/returns.routes.js";
import clientErrorRoutes from "./api/client-errors.routes.js";
import cashShiftRoutes from "./api/cash-shifts.routes.js";
import techCardRoutes from "./api/tech-cards.routes.js";
import catalogRoutes from "./api/catalog.routes.js";
import customerRoutes from "./api/customers.routes.js";
import { importSnapshot } from "./modules/catalog/catalog.import.js";
import { catalogService } from "./modules/catalog/catalog.service.js";
import { watchNationalCatalogue } from "./modules/catalog/catalog.tasnif.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = getEnv();
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
const io = initSocketIO(httpServer);
setSocketIO(io);

// Middleware
// Behind nginx (Docker) / the Vite dev proxy: take the client IP from
// X-Forwarded-For so rate limiting and audit see real addresses.
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(compression());
app.use(morgan("combined", {
  stream: { write: (message: string) => logger.info(message.trim()) },
  // Кассы проверяют связь по /api/health каждые 20 секунд — в журнале это шум.
  skip: (req) => req.url === "/health" || req.url === "/api/health",
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "..", env.UPLOAD_DIR)));

// Health check. /api/health — тот же ответ под префиксом API: касса проверяет
// по нему связь через тот же прокси, что и остальные запросы (nginx, vite).
app.get(["/health", "/api/health"], (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
// У /login, /login-pin и /staff есть свои, более строгие лимиты (см.
// middleware/rateLimiter.ts), но /refresh и /me до этого не были ограничены
// ничем: токен можно было перебирать и дёргать обновление без счёта.
// apiLimiter — общая сетка поверх точечных лимитов.
app.use("/api/auth", apiLimiter, authRoutes);
app.use("/api/products", apiLimiter, productRoutes);
app.use("/api/orders", apiLimiter, orderRoutes);
app.use("/api/payments", apiLimiter, paymentRoutes);
app.use("/api/users", apiLimiter, userRoutes);
app.use("/api/categories", apiLimiter, categoryRoutes);
app.use("/api/inventory", apiLimiter, inventoryRoutes);
app.use("/api/reports", apiLimiter, reportRoutes);
app.use("/api/tables", apiLimiter, tableRoutes);
app.use("/api/settings", apiLimiter, settingsRoutes);
app.use("/api/notifications", apiLimiter, notificationsRoutes);
app.use("/api/receipts", apiLimiter, receiptRoutes);
app.use("/api/audit", apiLimiter, auditRoutes);
app.use("/api/stock-receipts", apiLimiter, stockReceiptRoutes);
app.use("/api/returns", apiLimiter, returnRoutes);
app.use("/api/client-errors", clientErrorRoutes);
app.use("/api/cash-shifts", apiLimiter, cashShiftRoutes);
app.use("/api/tech-cards", apiLimiter, techCardRoutes);
app.use("/api/catalog", apiLimiter, catalogRoutes);
app.use("/api/customers", apiLimiter, customerRoutes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server
async function main() {
  try {
    await prisma.$connect();
    logger.info("Database connected");

    // Две вещи, которые Postgres делает «по настройке», а SQLite не делал вовсе.
    // Локаль: поиск без учёта регистра (ILIKE) складывает кириллицу, только
    // если у базы UTF-8-локаль, а не C — иначе «молоко» не найдёт «Молоко».
    // Часовой пояс сессии: Prisma пишет время в UTC, а значения по умолчанию
    // (CURRENT_TIMESTAMP) база считает в поясе сессии — они должны совпадать.
    const [dbCheck] = await prisma.$queryRaw<{ folds: boolean; tz: string }[]>`
      SELECT lower('МОЛОКО') = 'молоко' AND 'Молоко' ILIKE 'молоко' AS folds, current_setting('TimeZone') AS tz`;
    if (!dbCheck?.folds) {
      logger.error("Database locale does not fold Cyrillic case — product search will miss matches. Use a UTF-8 locale (en_US.UTF-8 or ICU)");
    }
    if (dbCheck && !["UTC", "Etc/UTC"].includes(dbCheck.tz)) {
      logger.warn("Database session TimeZone is not UTC — add options=-c%20TimeZone%3DUTC to DATABASE_URL", { timeZone: dbCheck.tz });
    }

    startStaleOrderSweeper(env.PENDING_ORDER_TTL_MINUTES);

    // Приватная сеть Railway (и её домены *.railway.internal) работает только
    // по IPv6, поэтому bind на 0.0.0.0 делал сервис недоступным для соседних
    // сервисов. "::" в Node открывает dual-stack сокет — IPv4 продолжает
    // работать, локально и в docker-compose ничего не меняется.
    httpServer.listen(env.PORT, "::", () => {
      logger.info(`Server running on port ${env.PORT}`);
      logger.info(`Environment: ${env.NODE_ENV}`);
      // Сообщение о запуске: после выкатки — «новая версия на месте», после
      // падения — «сервер перезапустился». Заодно проверка, что уведомления доходят.
      if (env.NODE_ENV === "production") {
        const version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
        alerts.notify(`🟢 <b>Qwik · сервер запущен</b>${version ? ` · версия ${version}` : ""}`);
      }
    });

    // The barcode catalogue loads in the background: the API is up at once and
    // lookups simply find more as the import proceeds. Tests seed their own rows.
    if (env.NODE_ENV !== "test") {
      importSnapshot().catch((error) => {
        logger.error("Barcode catalogue import failed", { message: error instanceof Error ? error.message : String(error) });
        alerts.report(error, { where: "загрузка базы штрихкодов при запуске" });
      });
      catalogService
        .probeSources()
        .then((reachable) => (reachable.openFoodFacts && reachable.nationalCatalogue ? logger.info : logger.warn)("Barcode sources reachable", reachable))
        .catch(() => undefined);
      watchNationalCatalogue();
    }
  } catch (error) {
    logger.error("Failed to start server", error);
    alerts.report(error, { where: "запуск сервера" });
    await alerts.flush();
    process.exit(1);
  }
}

main();

// Ошибка, которую никто не поймал, — тоже владельцу. Необработанный отказ
// промиса процесс не роняет (как и раньше), неперехваченное исключение — роняет:
// состояние после него ненадёжно, Railway поднимет сервер заново.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { message: reason instanceof Error ? reason.message : String(reason) });
  alerts.report(reason, { where: "необработанный отказ промиса" });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { message: error.message, stack: error.stack });
  alerts.report(error, { where: "неперехваченное исключение — сервер перезапускается" });
  void alerts.flush().finally(() => process.exit(1));
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down...");
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down...");
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});

export default app;
