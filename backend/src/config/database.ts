import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    // На Postgres транзакции продажи и прихода ждут блокировок строк товаров
    // (см. inventory/stock.helpers.ts), а база — по сети, а не файл рядом.
    // Умолчания Prisma (ожидание соединения 2 с, транзакция 5 с) на загруженной
    // кассе обрывали бы продажу посередине.
    transactionOptions: { maxWait: 5000, timeout: 10000 },
    // Без аргументов запроса в тексте ошибки: имена и телефоны клиентов не
    // должны уходить в логи, Telegram и Sentry.
    errorFormat: "minimal",
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
