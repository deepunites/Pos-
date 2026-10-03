-- Офлайн-режим кассы: продажи, пробитые без связи и отправленные позже.
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "offline_at" TIMESTAMP(3),
ADD COLUMN     "offline_price_changed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offline_shortfall" BOOLEAN NOT NULL DEFAULT false;
