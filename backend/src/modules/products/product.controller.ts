import { Request, Response } from "express";
import { productService } from "./product.service.js";
import { exportProducts, importProducts } from "./product.import.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";
import { handleError } from "../../utils/errors.js";
import type { ProductQueryInput } from "./product.schema.js";

export class ProductController {
  async findAll(req: Request, res: Response) {
    try {
      // The route validates and coerces the query string, so it is used as-is.
      const query = req.query as unknown as ProductQueryInput;
      const { products, total, page, limit } = await productService.findAll(req.user!.tenantId, query);
      sendPaginated(res, products, total, page, limit);
    } catch (error) {
      handleError(res, error);
    }
  }

  async lookup(req: Request, res: Response) {
    try {
      const product = await productService.lookup(req.user!.tenantId, String(req.query.code));
      sendSuccess(res, product);
    } catch (error) {
      handleError(res, error, 404);
    }
  }

  /** Импорт из Excel/CSV: apply=false — проверка («что будет»), true — запись. */
  async importRows(req: Request, res: Response) {
    try {
      sendSuccess(res, await importProducts(req.user!.tenantId, req.user!.id, req.body.rows, req.body.apply));
    } catch (error) {
      handleError(res, error);
    }
  }

  async exportAll(req: Request, res: Response) {
    try {
      sendSuccess(res, await exportProducts(req.user!.tenantId));
    } catch (error) {
      handleError(res, error);
    }
  }

  async lastSupply(req: Request, res: Response) {
    try {
      sendSuccess(res, await productService.lastSupply(req.user!.tenantId, req.query.ids as unknown as string[]));
    } catch (error) {
      handleError(res, error);
    }
  }

  async findById(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const product = await productService.findById(req.user!.tenantId, id);
      sendSuccess(res, product);
    } catch (error) {
      handleError(res, error, 404);
    }
  }

  async create(req: Request, res: Response) {
    try {
      const product = await productService.create(req.user!.tenantId, req.body);
      sendCreated(res, product);
    } catch (error) {
      handleError(res, error);
    }
  }

  async update(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const product = await productService.update(req.user!.tenantId, id, req.body);
      sendSuccess(res, product);
    } catch (error) {
      handleError(res, error);
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const result = await productService.delete(req.user!.tenantId, id);
      sendSuccess(res, result, result.removed === "deleted" ? "Товар удалён" : "Товар снят с продажи");
    } catch (error) {
      handleError(res, error);
    }
  }

  async adjustStock(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const { quantity, reason } = req.body;
      const product = await productService.adjustStock(
        req.user!.tenantId,
        id,
        quantity,
        reason,
        req.user!.id
      );
      sendSuccess(res, product);
    } catch (error) {
      handleError(res, error);
    }
  }

  async getIngredients(req: Request, res: Response) {
    try {
      const ingredients = await productService.getIngredients(req.user!.tenantId);
      sendSuccess(res, ingredients);
    } catch (error) {
      handleError(res, error);
    }
  }

  async calculateTechCardCost(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const cost = await productService.calculateTechCardCost(req.user!.tenantId, id);
      sendSuccess(res, { cost });
    } catch (error) {
      handleError(res, error);
    }
  }
}

export const productController = new ProductController();
