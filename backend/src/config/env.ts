import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // С 2026-10 база — PostgreSQL. Старая строка file:./dev.db от SQLite теперь
  // приводила бы к непонятной ошибке Prisma при первом запросе — лучше
  // сказать прямо при старте.
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL должен быть postgresql://… — SQLite (file:…) больше не поддерживается, см. RAILWAY.md"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_FILE_SIZE: z.coerce.number().default(5242880),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.string().default("info"),
  // Unpaid orders hold a stock reservation; after this many minutes they are
  // cancelled automatically and the stock is returned.
  PENDING_ORDER_TTL_MINUTES: z.coerce.number().int().min(1).default(30),
  // Попыток входа (/login, /register) за 15 минут с одного IP. 30 — защита от
  // перебора паролей; тестовый сервер поднимает планку, иначе набор тестов,
  // который входит под разными сотрудниками в каждом файле, упирался в неё.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  // Сколько прокси перед сервером: на Railway — край Railway и nginx кассы/панели.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(2),
  // Barcodes the shipped catalogue does not know are looked up live on Open Food
  // Facts (and its sister catalogues). OFF_BASE_URL sends every such lookup to
  // one server instead — the tests stand a stub in for the real thing.
  CATALOG_LIVE_LOOKUP: z.enum(["on", "off"]).default("on"),
  OFF_BASE_URL: z.string().url().optional(),
  // The national catalogue of Uzbekistan (tasnif.soliq.uz) is asked the same way; tests stub it too.
  TASNIF_BASE_URL: z.string().url().optional(),
  // Уведомления об ошибках владельцу (utils/alerts.ts). Без них — молчим.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
});

// Значения из .env.example. В проде с ними сервер подписывал бы токены
// секретом, который лежит в открытом репозитории.
const PLACEHOLDER_SECRETS = [
  "your-super-secret-jwt-key-change-in-production",
  "your-refresh-secret-key-change-in-production",
];

const envWithChecks = envSchema
  .refine((env) => env.JWT_SECRET !== env.JWT_REFRESH_SECRET, {
    path: ["JWT_REFRESH_SECRET"],
    message:
      "JWT_SECRET и JWT_REFRESH_SECRET должны различаться: с одинаковыми секретами токен доступа работает как токен обновления",
  })
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      (!PLACEHOLDER_SECRETS.includes(env.JWT_SECRET) &&
        !PLACEHOLDER_SECRETS.includes(env.JWT_REFRESH_SECRET)),
    {
      path: ["JWT_SECRET"],
      message: "В production нельзя оставлять секреты из .env.example",
    }
  );

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function getEnv(): Env {
  if (!_env) {
    _env = envWithChecks.parse(process.env);
  }
  return _env;
}
