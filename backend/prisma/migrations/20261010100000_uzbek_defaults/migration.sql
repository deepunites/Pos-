-- Новые точки: сумы и ташкентское время. Существующие точки не меняются.
ALTER TABLE "tenants" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Tashkent';
ALTER TABLE "tenants" ALTER COLUMN "currency" SET DEFAULT 'UZS';
