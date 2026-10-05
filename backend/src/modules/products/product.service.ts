import type { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import type { CreateProductInput, UpdateProductInput, ProductQueryInput } from "./product.schema.js";
import { AppError, NotFoundError } from "../../utils/errors.js";
import { ci, searchTokens } from "../../utils/search.js";
import { catalogService } from "../catalog/catalog.service.js";
import { lockStockRows, roundStock } from "../inventory/stock.helpers.js";
import { inTransaction } from "../../utils/transaction.js";

// saleUnit values that mean "sold by weight" — see gramsPerUnit().
const WEIGHT_UNITS = ["г", "кг", "g", "kg"];

export class ProductService {
  async findAll(tenantId: string, query: ProductQueryInput) {
    const { search, categoryId, isActive = true, isIngredient, minPrice, maxPrice, inStock, weighted, noBarcode, tag, sort = "sortOrder", order = "asc", page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    // Every filter is its own AND clause: a previous version put both the
    // text search and the ingredient filter on `where.OR`, so whichever ran
    // last silently replaced the other.
    const and: Prisma.ProductWhereInput[] = [];
    const where: Prisma.ProductWhereInput = { tenantId, AND: and };
    // Every word of the search must match the name (in any spelling of its
    // case — see utils/search.ts), or be found in the SKU / barcode.
    for (const token of searchTokens(search || "")) {
      and.push({
        OR: [
          { name: ci(token) },
          { sku: ci(token) },
          { barcode: { contains: token } },
        ],
      });
    }
    if (weighted === true) and.push({ saleUnit: { in: WEIGHT_UNITS } });
    else if (weighted === false) and.push({ OR: [{ saleUnit: null }, { saleUnit: { notIn: WEIGHT_UNITS } }] });
    if (noBarcode === true) and.push({ OR: [{ barcode: null }, { barcode: "" }] });
    // tags is a JSON array kept as text, e.g. ["quick"]
    if (tag) and.push({ tags: { contains: JSON.stringify(tag) } });
    if (categoryId) where.categoryId = categoryId;
    if (isActive !== undefined) where.isActive = isActive;
    if (isIngredient === false) {
      and.push({ isIngredient: false });
      and.push({ OR: [{ categoryId: null }, { category: { isIngredient: false } }] });
    } else if (isIngredient === true) {
      and.push({ OR: [{ isIngredient: true }, { category: { isIngredient: true } }] });
    }
    const price: Prisma.FloatFilter = {};
    if (minPrice !== undefined) price.gte = minPrice;
    if (maxPrice !== undefined) price.lte = maxPrice;
    if (minPrice !== undefined || maxPrice !== undefined) where.price = price;
    if (inStock !== undefined) {
      where.currentStock = inStock ? { gt: 0 } : { lte: 0 };
    }

    // Ties (equal sortOrder, which is every product until an admin arranges them)
    // fall back to the name so pages of a long catalogue are stable.
    const orderBy = (sort === "name" ? { name: order } : [{ [sort]: order }, { name: "asc" }]) as
      | Prisma.ProductOrderByWithRelationInput
      | Prisma.ProductOrderByWithRelationInput[];

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, color: true } },
          techCardRef: { select: { id: true, name: true, totalCost: true, output: true, unit: true, ingredients: true } },
          modifierGroups: {
            include: {
              modifierGroup: {
                include: { modifierItems: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
              },
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);

    return { products, total, page, limit };
  }

  // Exact match on what the scanner read (barcode) or on the short code typed
  // on the keypad (SKU). Only sellable goods: no ingredients, nothing archived.
  // A barcode match wins over an SKU match, so a short code that happens to
  // equal some other product's barcode cannot shadow the real scan.
  async lookup(tenantId: string, code: string) {
    const sellable = {
      tenantId,
      isActive: true,
      isIngredient: false,
      OR: [{ categoryId: null }, { category: { isIngredient: false } }],
    };
    const include = { category: { select: { id: true, name: true, color: true } } };
    const orderBy = [{ sortOrder: "asc" as const }, { name: "asc" as const }];

    // The same product reads as 12 digits (UPC-A) on one scanner and as 13
    // (EAN-13 with a leading zero) on another; the catalogue may hold either.
    const barcodes = new Set([code]);
    if (/^\d{12}$/.test(code)) barcodes.add("0" + code);
    if (/^0\d{12}$/.test(code)) barcodes.add(code.slice(1));

    const product =
      (await prisma.product.findFirst({ where: { ...sellable, barcode: { in: [...barcodes] } }, include, orderBy })) ??
      (await prisma.product.findFirst({ where: { ...sellable, sku: code }, include, orderBy }));
    if (!product) throw new NotFoundError("Товар не найден");
    return product;
  }

  async findById(tenantId: string, id: string) {
    const product = await prisma.product.findFirst({
      where: { id, tenantId },
      include: {
        category: true,
        techCardRef: true,
        modifierGroups: {
          include: {
            modifierGroup: {
              include: { modifierItems: { orderBy: { sortOrder: "asc" } } },
            },
          },
        },
      },
    });
    if (!product) throw new NotFoundError("Товар не найден");
    return product;
  }

  // Ids that arrive from the client must belong to the caller's tenant —
  // otherwise a product could be attached to another shop's category or
  // recipe.
  private async assertReferencesOwned(tenantId: string, data: { categoryId?: string | null; techCardId?: string | null }) {
    if (data.categoryId) {
      const category = await prisma.category.findFirst({ where: { id: data.categoryId, tenantId } });
      if (!category) throw new NotFoundError("Категория не найдена");
    }
    if (data.techCardId) {
      const techCard = await prisma.techCard.findFirst({ where: { id: data.techCardId, tenantId } });
      if (!techCard) throw new NotFoundError("Техкарта не найдена");
    }
  }

  async create(tenantId: string, data: CreateProductInput) {
    await this.assertReferencesOwned(tenantId, data);
    const { tags, techCard, ...rest } = data;
    // Магазин ведёт остаток у каждого товара: продажа его уменьшает, в минус тоже.
    if (await isRetail(tenantId)) rest.trackInventory = true;

    let conversionFactor = data.conversionFactor;
    if (data.purchaseUnit && data.saleUnit && !conversionFactor) {
      conversionFactor = this.calculateConversionFactor(data.purchaseUnit, data.saleUnit);
    }

    const product = await prisma.product.create({
      data: {
        ...rest,
        tenantId,
        conversionFactor,
        tags: tags ? JSON.stringify(tags) : undefined,
        techCard: techCard !== undefined ? JSON.stringify(techCard) : undefined,
      },
      include: { category: true, techCardRef: true },
    });

    // A barcoded product a shop enters by hand teaches the shared catalogue too.
    if (product.barcode) void catalogService.contribute(tenantId, { barcode: product.barcode, name: product.name, category: product.category?.name });
    return product;
  }

  async update(tenantId: string, id: string, data: UpdateProductInput) {
    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) throw new NotFoundError("Товар не найден");
    await this.assertReferencesOwned(tenantId, data);

    const { tags, techCard, ...rest } = data;
    if (rest.trackInventory === false && (await isRetail(tenantId))) rest.trackInventory = true;

    let conversionFactor = data.conversionFactor;
    if (data.purchaseUnit && data.saleUnit && !conversionFactor) {
      conversionFactor = this.calculateConversionFactor(data.purchaseUnit, data.saleUnit);
    }

    return prisma.product.update({
      where: { id },
      data: {
        ...rest,
        conversionFactor,
        tags: tags !== undefined ? JSON.stringify(tags) : undefined,
        techCard: techCard !== undefined ? JSON.stringify(techCard) : undefined,
      },
      include: { category: true, techCardRef: true },
    });
  }

  private calculateConversionFactor(purchaseUnit: string, saleUnit: string): number | undefined {
    const conversions: Record<string, Record<string, number>> = {
      "кг": { "г": 1000 },
      "л": { "мл": 1000 },
      "упаковка": { "г": 1000, "мл": 1000 },
    };
    return conversions[purchaseUnit]?.[saleUnit];
  }

  async calculateTechCardCost(tenantId: string, productId: string): Promise<number> {
    const product = await prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: { techCardRef: true },
    });
    if (!product) throw new NotFoundError("Товар не найден");

    if (product.techCardRef) {
      return product.techCardRef.totalCost;
    }

    const techCard = JSON.parse(product.techCard || "[]") as { ingredientId: string; quantity: number; unit: string }[];
    if (techCard.length === 0) return product.costPrice;

    let totalCost = 0;
    for (const item of techCard) {
      const ingredient = await prisma.product.findFirst({
        where: { id: item.ingredientId, tenantId },
      });
      if (ingredient) {
        totalCost += ingredient.costPrice * item.quantity;
      }
    }

    return totalCost;
  }

  async getIngredients(tenantId: string) {
    return prisma.product.findMany({
      where: { tenantId, isIngredient: true, isActive: true },
      select: {
        id: true,
        name: true,
        sku: true,
        costPrice: true,
        currentStock: true,
        unit: true,
        purchaseUnit: true,
        saleUnit: true,
      },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Последняя поставка каждого товара: цена, дата, поставщик — подсказка в
   * форме товара и в строке прихода («посл.: 11 000 · 28 сен»).
   */
  async lastSupply(tenantId: string, ids: string[]) {
    const rows = await prisma.$queryRaw<{ product_id: string; cost_price: number; created_at: Date; supplier_name: string | null }[]>`
      SELECT DISTINCT ON (i.product_id) i.product_id, i.cost_price, r.created_at, r.supplier_name
      FROM stock_receipt_items i
      JOIN stock_receipts r ON r.id = i.receipt_id
      WHERE r.tenant_id = ${tenantId} AND i.product_id = ANY(${ids}::text[])
      ORDER BY i.product_id, r.created_at DESC`;
    return Object.fromEntries(
      rows.map((r) => [r.product_id, { costPrice: r.cost_price, date: r.created_at, supplierName: r.supplier_name }])
    );
  }

  // Товар без продаж и приходов удаляется насовсем — заведённый по ошибке или
  // тестовый не должен жить в базе и в выгрузке. Товар с историей только
  // снимается с продажи: на его строки ссылаются чеки, приходы и отчёты.
  // Ингредиент, который стоит в техкарте, тоже только снимается.
  async delete(tenantId: string, id: string): Promise<{ removed: "deleted" | "archived" }> {
    const product = await prisma.product.findFirst({ where: { id, tenantId } });
    if (!product) throw new NotFoundError("Товар не найден");

    const [sold, received, inRecipe] = await Promise.all([
      prisma.orderItem.count({ where: { productId: id } }),
      prisma.stockReceiptItem.count({ where: { productId: id } }),
      product.isIngredient
        ? Promise.all([
            prisma.techCard.count({ where: { tenantId, ingredients: { contains: id } } }),
            prisma.product.count({ where: { tenantId, techCard: { contains: id } } }),
          ]).then(([cards, products]) => cards + products)
        : Promise.resolve(0),
    ]);

    if (sold || received || inRecipe) {
      await prisma.product.update({ where: { id }, data: { isActive: false } });
      return { removed: "archived" };
    }

    // Остаток, внесённый вручную или импортом, — движения без чеков и приходов: уходят вместе с товаром.
    await inTransaction(async (tx) => {
      await tx.inventoryMovement.deleteMany({ where: { tenantId, productId: id } });
      await tx.product.delete({ where: { id } });
    });
    return { removed: "deleted" };
  }

  async adjustStock(tenantId: string, productId: string, quantity: number, reason: string, userId: string) {
    // Под блокировкой строки товара (lockStockRows) и в одной транзакции:
    // раньше остаток читался до транзакции, и корректировка, совпавшая с
    // продажей, затирала её списание.
    return inTransaction(async (tx) => {
      await lockStockRows(tx, tenantId, [productId]);
      const product = await tx.product.findFirst({ where: { id: productId, tenantId } });
      if (!product) throw new NotFoundError("Товар не найден");

      // Округление, как у остатка везде: без него 84,2 − 1,24 записывалось
      // как 82,96000000000001.
      const newStock = roundStock(product.currentStock + quantity);
      if (newStock < 0) throw new AppError("Недостаточно остатка");

      const updated = await tx.product.update({
        where: { id: productId },
        data: { currentStock: newStock },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          productId,
          type: quantity > 0 ? "in" : "out",
          quantity: Math.abs(quantity),
          reason,
          userId,
        },
      });

      return updated;
    });
  }
}

export const productService = new ProductService();

/** Магазин (retail): остаток ведётся у каждого товара, продажа уходит в минус (2026-10-05). */
export async function isRetail(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { businessType: true } });
  return tenant?.businessType === "retail";
}
