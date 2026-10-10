import { Router } from "express";
import { customerController } from "../modules/customers/customer.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditLog } from "../middleware/audit.js";
import { createCustomerSchema, customerQuerySchema, repaymentSchema, updateCustomerSchema } from "../modules/customers/customer.schema.js";

// Клиенты заведения и их долги. Кассир ищет и добавляет клиентов и принимает
// погашения; оценку, заметку и «не давать в долг» меняют админ и управляющий.
const router = Router();

router.use(authenticate);

router.get("/", validate(customerQuerySchema, "query"), (req, res) => customerController.list(req, res));
router.get("/summary", authorize("admin", "manager"), (req, res) => customerController.summary(req, res));
router.get("/:id", (req, res) => customerController.findById(req, res));
router.post("/", validate(createCustomerSchema), auditLog("customer.create", "customer"), (req, res) => customerController.create(req, res));
router.patch("/:id", authorize("admin", "manager"), validate(updateCustomerSchema), auditLog("customer.update", "customer"), (req, res) => customerController.update(req, res));
// Деньги в кассу принимают касса и управляющие; официант и кухня — нет.
router.post("/:id/repayments", authorize("admin", "manager", "cashier"), validate(repaymentSchema), auditLog("customer.repayment", "customer"), (req, res) => customerController.repay(req, res));

export default router;
