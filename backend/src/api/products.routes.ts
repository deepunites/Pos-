import { Router } from "express";
import { productController } from "../modules/products/product.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditLog } from "../middleware/audit.js";
import { createProductSchema, updateProductSchema, productQuerySchema, productLookupSchema, lastSupplyQuerySchema } from "../modules/products/product.schema.js";
import { adjustStockSchema } from "../modules/common.schema.js";

const router = Router();

router.use(authenticate);

router.get("/", validate(productQuerySchema, "query"), (req, res) => productController.findAll(req, res));
router.get("/ingredients", (req, res) => productController.getIngredients(req, res));
// Before "/:id" — otherwise "lookup" would be taken for a product id.
router.get("/lookup", validate(productLookupSchema, "query"), (req, res) => productController.lookup(req, res));
router.get("/last-supply", validate(lastSupplyQuerySchema, "query"), (req, res) => productController.lastSupply(req, res));
router.get("/:id", (req, res) => productController.findById(req, res));
router.get("/:id/tech-card-cost", (req, res) => productController.calculateTechCardCost(req, res));
router.post("/", authorize("admin", "manager"), validate(createProductSchema), auditLog("product.create", "product"), (req, res) => productController.create(req, res));
router.put("/:id", authorize("admin", "manager"), validate(updateProductSchema), auditLog("product.update", "product"), (req, res) => productController.update(req, res));
router.delete("/:id", authorize("admin", "manager"), auditLog("product.delete", "product"), (req, res) => productController.delete(req, res));
router.post("/:id/stock", authorize("admin", "manager"), validate(adjustStockSchema), auditLog("product.stock_adjust", "product"), (req, res) => productController.adjustStock(req, res));

export default router;
