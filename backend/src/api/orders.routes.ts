import { Router } from "express";
import { orderController } from "../modules/orders/order.controller.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { auditLog } from "../middleware/audit.js";
import { createOrderSchema, checkoutSchema, updateOrderStatusSchema, orderQuerySchema, kitchenStatusSchema } from "../modules/orders/order.schema.js";

const router = Router();

router.use(authenticate);

router.get("/active", (req, res) => orderController.getActive(req, res));
// Экран кухни: повар, администратор, менеджер. Кассиру менять кухонный шаг незачем.
router.get("/kitchen", authorize("admin", "manager", "kitchen"), (req, res) => orderController.getKitchen(req, res));
router.get("/", authorize("admin", "manager"), validate(orderQuerySchema, "query"), (req, res) => orderController.findAll(req, res));
router.get("/:id", (req, res) => orderController.findById(req, res));
router.post("/", validate(createOrderSchema), auditLog("order.create", "order"), (req, res) => orderController.create(req, res));
router.post("/checkout", authorize("admin", "manager", "cashier"), validate(checkoutSchema), auditLog("order.checkout", "order"), (req, res) => orderController.checkout(req, res));
// Кухне — только свои шаги (/kitchen): статус заказа и отмена — зал и касса.
router.patch("/:id/status", authorize("admin", "manager", "cashier", "waiter"), validate(updateOrderStatusSchema), auditLog("order.status", "order"), (req, res) => orderController.updateStatus(req, res));
router.patch("/:id/kitchen", authorize("admin", "manager", "kitchen"), validate(kitchenStatusSchema), auditLog("order.kitchen", "order"), (req, res) => orderController.updateKitchenStatus(req, res));
router.post("/:id/cancel", authorize("admin", "manager", "cashier", "waiter"), auditLog("order.cancel", "order"), (req, res) => orderController.cancel(req, res));

export default router;
