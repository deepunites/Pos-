import prisma from "../../config/database.js";
import { AppError } from "../../utils/errors.js";

// businessType здесь нет: тип заведения выбирается только при регистрации.
// Поле молча пропускается, а не отклоняется — открытые старые админки ещё
// присылают его при каждом сохранении «Общих».
const ALLOWED_FIELDS = [
  "name",
  "logoUrl",
  "phone",
  "email",
  "address",
  "timezone",
  "currency",
  "taxRate",
  "defaultMarkupPercent",
  "catalogSharing",
  "settings",
] as const;

export const settingsService = {
  async get(tenantId: string) {
    return prisma.tenant.findUnique({
      where: { id: tenantId },
    });
  },

  async update(tenantId: string, data: Record<string, unknown>) {
    if ("catalogSharing" in data && typeof data.catalogSharing !== "boolean") {
      throw new AppError("Некорректное значение настройки общей базы");
    }
    const safeData: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in data) {
        safeData[key] = data[key];
      }
    }

    return prisma.tenant.update({
      where: { id: tenantId },
      data: safeData,
    });
  },
};
