import { Router } from "express";
import { returnController } from "../modules/returns/return.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditLog } from "../middleware/audit.js";
import { createReturnSchema, saleSearchSchema } from "../modules/returns/return.schema.js";

// Возврат товара на кассе. Кассиру — по галочке «Возврат товара» в карточке.
const router = Router();

router.use(authenticate);

router.get("/sales", authorize("admin", "manager", "cashier"), validate(saleSearchSchema, "query"), (req, res) => returnController.sales(req, res));
router.post("/", authorize("admin", "manager", "cashier"), validate(createReturnSchema), auditLog("sale.return", "sale_return"), (req, res) => returnController.create(req, res));

export default router;
