-- Магазин ведёт остаток у каждого товара: продажа его уменьшает и может увести
-- в минус (решение владельца, 2026-10-05). Товары магазинов, заведённые без
-- учёта (скан без количества, импорт без колонки «Остаток»), начинают считаться.
-- Кафе не трогаем: там учёт включают у тех товаров, где он нужен.
UPDATE "products" AS p
SET "track_inventory" = true
FROM "tenants" AS t
WHERE p."tenant_id" = t."id"
  AND t."business_type" = 'retail'
  AND p."is_ingredient" = false
  AND p."track_inventory" = false;
