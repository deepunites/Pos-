import type { Prisma, Tenant } from "@prisma/client";
import prisma from "../../config/database.js";
import { NotFoundError } from "../../utils/errors.js";
import { formatMoney } from "../../utils/money.js";

// Receipt HTML is assembled from user-entered strings (shop name, customer
// name, product names) — escape them so a stray "<" can't break or script the
// receipt window.
const escapeHtml = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Что нужно чеку от заказа — один раз, и тип данных чека выводится отсюда же.
const receiptInclude = {
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true } },
      modifiers: { include: { modifierItem: true } },
    },
  },
  table: { select: { id: true, number: true } },
  user: { select: { id: true, firstName: true, lastName: true } },
  payments: true,
} satisfies Prisma.OrderInclude;

type ReceiptOrder = Prisma.OrderGetPayload<{ include: typeof receiptInclude }>;

export interface ReceiptData {
  order: ReceiptOrder;
  tenant: Tenant | null;
  payments: ReceiptOrder["payments"];
  items: ReceiptOrder["items"];
}

export class ReceiptService {
  async getReceiptData(tenantId: string, orderId: string): Promise<ReceiptData> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: receiptInclude,
    });

    if (!order) throw new NotFoundError("Заказ не найден");

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    return {
      order,
      tenant,
      payments: order.payments,
      items: order.items,
    };
  }

  async generateReceiptHTML(tenantId: string, orderId: string): Promise<string> {
    const data = await this.getReceiptData(tenantId, orderId);
    return this.buildReceiptHTML(data);
  }

  async markAsPrinted(tenantId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundError("Заказ не найден");

    const existingReceipt = await prisma.receipt.findFirst({
      where: { orderId },
    });

    if (existingReceipt) {
      return prisma.receipt.update({
        where: { id: existingReceipt.id },
        data: { printedAt: new Date() },
      });
    }

    return prisma.receipt.create({
      data: {
        tenantId,
        orderId,
        printedAt: new Date(),
        template: "standard",
      },
    });
  }

  private buildReceiptHTML(data: ReceiptData): string {
    const { order, tenant, items } = data;
    const now = new Date();
    const dateStr = now.toLocaleDateString("ru-RU");
    const timeStr = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

    const retail = tenant?.businessType === "retail";
    const money = (n: unknown) => escapeHtml(formatMoney(Number(n), tenant?.currency));

    const itemsHTML = items.map((item) => {
      const modifiersText = item.modifiers?.length
        ? item.modifiers.map((m) => `  + ${escapeHtml(m.modifierItem.name)} (${money(m.price)})`).join("\n")
        : "";
      const modifiersRow = modifiersText ? `<tr><td class="modifier">${modifiersText}</td><td></td></tr>` : "";

      if (retail) {
        // A shop check reads like a shop check: the name on its own line, then
        // "quantity × price" against the line total. Weighed goods show the
        // weight in kilograms and the price per kilogram, whichever unit the
        // product is stocked in.
        const quantity = item.weightGrams
          ? `${(Number(item.weightGrams) / 1000).toFixed(3).replace(".", ",")} кг × ${money(
              (Number(item.unitPrice) * 1000) / Number(item.weightGrams)
            )}/кг`
          : `${item.quantity} × ${money(item.unitPrice)}`;
        return `
        <tr><td colspan="2">${escapeHtml(item.product.name)}</td></tr>
        <tr><td class="modifier">${quantity}</td><td class="right">${money(item.totalPrice)}</td></tr>
        ${modifiersRow}
      `;
      }

      const weight = item.weightGrams ? ` (${Number(item.weightGrams)} г)` : "";
      const unit = item.quantity > 1 ? ` × ${money(item.unitPrice)}` : "";
      return `
        <tr>
          <td>${item.quantity}x ${escapeHtml(item.product.name)}${weight}${unit}</td>
          <td class="right">${money(item.totalPrice)}</td>
        </tr>
        ${modifiersRow}
      `;
    }).join("");

    const PAYMENT_LABELS: Record<string, string> = {
      cash: "Наличные",
      card: "Карта",
      qr: "QR",
      online: "Онлайн",
      gift_card: "Подарочная карта",
    };
    const paymentMethod = PAYMENT_LABELS[order.payments?.[0]?.method] ?? "Наличные";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Чек №${order.orderNumber}</title>
  <style>
    @media print {
      body { margin: 0; padding: 0; }
      .no-print { display: none !important; }
    }
    body {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      width: 80mm;
      margin: 0 auto;
      padding: 10mm;
      background: white;
      color: black;
    }
    .header {
      text-align: center;
      border-bottom: 1px dashed #000;
      padding-bottom: 8px;
      margin-bottom: 8px;
    }
    .header h2 {
      margin: 0;
      font-size: 16px;
    }
    .header p {
      margin: 2px 0;
      font-size: 10px;
    }
    .info {
      margin-bottom: 8px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
    }
    td {
      padding: 2px 0;
      vertical-align: top;
    }
    .right {
      text-align: right;
    }
    .modifier {
      font-size: 10px;
      color: #333;
    }
    .totals {
      border-top: 1px dashed #000;
      padding-top: 8px;
      margin-top: 8px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-weight: bold;
    }
    .footer {
      text-align: center;
      border-top: 1px dashed #000;
      padding-top: 8px;
      margin-top: 8px;
      font-size: 10px;
    }
    .print-btn {
      display: block;
      width: 100%;
      padding: 12px;
      margin-top: 20px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
    }
    .print-btn:hover {
      background: #1d4ed8;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>${escapeHtml(tenant?.name || "Qwik")}</h2>
    <p>${escapeHtml(tenant?.address || "")}</p>
    <p>${escapeHtml(tenant?.phone || "")}</p>
  </div>

  <div class="info">
    <div class="info-row">
      <span>Чек №:</span>
      <span>${order.orderNumber}</span>
    </div>
    <div class="info-row">
      <span>Дата:</span>
      <span>${dateStr} ${timeStr}</span>
    </div>
    ${retail ? "" : `<div class="info-row">
      <span>Тип:</span>
      <span>${order.type === "dine_in" ? "В зале" : order.type === "takeaway" ? "Навынос" : escapeHtml(order.type)}</span>
    </div>`}
    ${!retail && order.table ? `<div class="info-row"><span>Стол:</span><span>${escapeHtml(order.table.number)}</span></div>` : ""}
    ${order.customerName ? `<div class="info-row"><span>Клиент:</span><span>${escapeHtml(order.customerName)}</span></div>` : ""}
    ${order.user ? `<div class="info-row"><span>${retail ? "Кассир" : "Официант"}:</span><span>${escapeHtml(order.user.firstName)}</span></div>` : ""}
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:left">Наименование</th>
        <th style="text-align:right">Сумма</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHTML}
    </tbody>
  </table>

  <div class="totals">
    <div class="total-row">
      <span>Подытог:</span>
      <span>${money(order.subtotal)}</span>
    </div>
    ${Number(order.taxAmount) > 0 ? `
    <div class="total-row">
      <span>Налог:</span>
      <span>${money(order.taxAmount)}</span>
    </div>
    ` : ""}
    ${Number(order.discountAmount) > 0 ? `
    <div class="total-row">
      <span>Скидка:</span>
      <span>-${money(order.discountAmount)}</span>
    </div>
    ` : ""}
    <div class="total-row" style="font-size: 14px; margin-top: 4px;">
      <span>ИТОГО:</span>
      <span>${money(order.total)}</span>
    </div>
  </div>

  <div class="info" style="margin-top: 8px;">
    ${(order.payments?.length ?? 0) > 1
      ? // Оплата частями («Карта + наличные») — каждая часть своей строкой.
        `<div class="info-row"><span>Оплата:</span><span>частями</span></div>` +
        order.payments
          .map((p) => `<div class="info-row"><span>${escapeHtml(PAYMENT_LABELS[p.method] ?? p.method)}:</span><span>${money(p.amount)}</span></div>`)
          .join("")
      : `
    <div class="info-row">
      <span>Оплата:</span>
      <span>${paymentMethod}</span>
    </div>
    ${order.payments?.[0]?.amount ? `
    <div class="info-row">
      <span>Сумма оплаты:</span>
      <span>${money(order.payments[0].amount)}</span>
    </div>
    ` : ""}`}
  </div>

  <div class="footer">
    <p>Спасибо за покупку!</p>
    <p>${escapeHtml((() => { try { return tenant?.settings ? JSON.parse(tenant.settings).receipt_footer || "" : ""; } catch { return ""; } })())}</p>
  </div>

  <button class="print-btn no-print" onclick="window.print()">🖨️ Печать чека</button>
</body>
</html>`;
  }
}

export const receiptService = new ReceiptService();
