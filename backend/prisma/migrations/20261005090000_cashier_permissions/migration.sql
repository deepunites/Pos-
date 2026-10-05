-- AlterTable
ALTER TABLE "users" ADD COLUMN     "can_receive_stock" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "can_see_expected_cash" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "can_sell_on_debt" BOOLEAN NOT NULL DEFAULT true;
