import api from "../services/api";

/**
 * Prints the server-rendered receipt through a hidden iframe. A popup window
 * would be blocked in kiosk browsers (and anywhere popups are off), which once
 * left the cashier with no way to print at all.
 */
export async function printReceipt(orderId: string): Promise<void> {
  const response = await api.get(`/receipts/${orderId}`, { responseType: "text" });
  printHtml(response.data as string);
  await api.post(`/receipts/${orderId}/print`);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface OfflineSlip {
  shopName: string;
  soldAt: number;
  lines: { name: string; quantity: number; grams?: number; total: number }[];
  total: number;
  tendered: number | null;
  change: number;
  money: (amount: number) => string;
}

/**
 * Чек продажи без связи — собирается на самом планшете: сервер его ещё не
 * видел, номера у него нет. Внизу честно сказано, что чек будет передан на
 * сервер, когда появится связь.
 */
export function printOfflineReceipt(slip: OfflineSlip): void {
  const row = (left: string, right: string) => `<tr><td>${escapeHtml(left)}</td><td class="r">${escapeHtml(right)}</td></tr>`;
  const lines = slip.lines
    .map((l) => row(l.grams ? `${l.name}, ${(l.grams / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг` : `${l.name} × ${l.quantity}`, slip.money(l.total)))
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Чек</title><style>
    body{font-family:monospace;font-size:12px;width:72mm;margin:0 auto;padding:4mm 0;color:#000}
    h1{font-size:14px;text-align:center;margin:0 0 4px}.c{text-align:center}table{width:100%;border-collapse:collapse}
    td{padding:1px 0;vertical-align:top}.r{text-align:right;white-space:nowrap;padding-left:8px}
    .t td{font-weight:bold;font-size:14px;border-top:1px dashed #000;padding-top:4px}.n{margin-top:8px;border-top:1px dashed #000;padding-top:4px;text-align:center}
  </style></head><body>
    <h1>${escapeHtml(slip.shopName)}</h1>
    <div class="c">${escapeHtml(new Date(slip.soldAt).toLocaleString("ru-RU"))}</div>
    <table>${lines}<tr class="t"><td>Итого</td><td class="r">${escapeHtml(slip.money(slip.total))}</td></tr>
    ${row("Наличные", slip.money(slip.tendered ?? slip.total))}${slip.change > 0 ? row("Сдача", slip.money(slip.change)) : ""}</table>
    <div class="n">Продажа без связи. Чек будет передан на сервер, когда появится интернет.</div>
  </body></html>`;
  printHtml(html);
}

function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error("no document");
  }
  doc.open();
  doc.write(html);
  doc.close();

  // Give the print dialog a moment to take its snapshot before the frame goes away.
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  win.addEventListener("afterprint", cleanup, { once: true });
  win.focus();
  win.print();
  // Safari/Chrome do not always emit afterprint; remove it anyway.
  setTimeout(cleanup, 5000);
}
