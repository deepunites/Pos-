import { Router } from "express";
import { stockReceiptController } from "../modules/stock-receipts/stock-receipt.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { stockReceiptQuerySchema } from "../modules/common.schema.js";
import { auditLog } from "../middleware/audit.js";
import { createStockReceiptSchema } from "../modules/stock-receipts/stock-receipt.schema.js";

const router = Router();

router.use(authenticate);

router.get("/", authorize("admin", "manager"), validate(stockReceiptQuerySchema, "query"), (req, res) => stockReceiptController.findAll(req, res));
router.get("/next-number", authorize("admin", "manager", "cashier"), (req, res) => stockReceiptController.nextNumber(req, res));
router.get("/:id", authorize("admin", "manager"), (req, res) => stockReceiptController.findById(req, res));
router.post("/", authorize("admin", "manager", "cashier"), validate(createStockReceiptSchema), auditLog("stock_receipt.create", "stock_receipt"), (req, res) => stockReceiptController.create(req, res));
router.delete("/:id", authorize("admin", "manager"), auditLog("stock_receipt.delete", "stock_receipt"), (req, res) => stockReceiptController.delete(req, res));

export default router;
