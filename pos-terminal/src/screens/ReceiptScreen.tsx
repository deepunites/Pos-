import { useEffect, useState, useMemo } from "react";
import { CheckCircle, Printer, Download, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import api from "../services/api";
import type { Order } from "../types";
import { useMoney } from "../hooks/useMoney";
import { useHoldAppUpdate } from "../services/appUpdate";


const sportQuotes = [
  "Спорт — это жизнь. Каждый глоток — шаг к цели!",
  "Сила не в мышцах, а в характере!",
  "Пей воду — будь на коне!",
  "Здоровье — лучший актив. Инвестируй в себя!",
  "Движение — это свобода. Пей и двигайся!",
  "Чемпионы не сдаются. Они делают глоток и идут дальше!",
  "Энергия начинается с правильного выбора!",
  "Будь сильнее, чем вчера!",
  "Тело — твой храм. Наполняй его правильно!",
  "Каждый шаг начинается с первого глотка!",
];

function getRandomQuote(): string {
  return sportQuotes[Math.floor(Math.random() * sportQuotes.length)];
}

interface ReceiptModalProps {
  order: Order;
  onNewOrder: () => void;
}

export default function ReceiptModal({ order, onNewOrder }: ReceiptModalProps) {
  useHoldAppUpdate();
  const { money, shopName } = useMoney();
  const [showSuccess, setShowSuccess] = useState(true);
  const quote = useMemo(() => getRandomQuote(), []);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowSuccess(false), 2200);
    return () => clearTimeout(timer);
  }, []);

  const handlePrint = async (): Promise<void> => {
    setPrinting(true);
    try {
      const response = await api.get(`/receipts/${order.id}`, { responseType: "text" });

      // Printed from a hidden iframe rather than a popup window: kiosk
      // browsers (and any browser with popup blocking on) silently refuse
      // window.open, which left the cashier with no way to print at all.
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.position = "fixed";
      frame.style.right = "0";
      frame.style.bottom = "0";
      frame.style.width = "0";
      frame.style.height = "0";
      frame.style.border = "0";
      document.body.appendChild(frame);

      const doc = frame.contentDocument;
      if (!doc) throw new Error("no document");
      doc.open();
      doc.write(response.data as string);
      doc.close();

      const cleanup = () => {
        // Give the print dialog a moment to take its snapshot before the
        // frame goes away.
        setTimeout(() => frame.remove(), 1000);
      };

      const win = frame.contentWindow;
      if (!win) throw new Error("no window");
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
      // Safari/Chrome do not always emit afterprint; remove it anyway.
      setTimeout(cleanup, 5000);

      await api.post(`/receipts/${order.id}/print`);
      toast.success("Чек отправлен на печать", { duration: 1500 });
    } catch (error) {
      toast.error("Ошибка печати чека");
    } finally {
      setPrinting(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    try {
      const response = await api.get(`/receipts/${order.id}`, { responseType: "text" });
      const blob = new Blob([response.data as string], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${order.orderNumber}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error("Ошибка скачивания чека");
    }
  };

  if (showSuccess) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950/90" style={{ animation: "fade-in 0.3s ease" }}>
        <div className="text-center" style={{ animation: "scale-in 0.4s ease" }}>
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-500/15">
            <CheckCircle className="h-12 w-12 text-success-500" />
          </div>
          <h1 className="mt-5 text-2xl font-bold text-dark-50">Оплачено!</h1>
          <p className="mt-1.5 text-sm text-dark-400">Заказ №{order.orderNumber} — {money(Number(order.total))}</p>
          {order.kitchenStatus === "new" && <p className="mt-1 text-sm font-medium text-primary-400">Передан на кухню</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ animation: "fade-in 0.2s ease" }}>
      <div className="absolute inset-0 bg-black/70" />

      <div
        className="relative mx-4 w-full max-w-md max-h-[85vh] overflow-y-auto rounded-md border border-dark-600 bg-dark-800 shadow-2xl"
        style={{ animation: "scale-in 0.25s ease" }}
      >
        <div className="p-6">
          <div className="pb-4 text-center">
            <h2 className="text-xl font-bold text-dark-50">{shopName}</h2>
            <p className="mt-1 text-xs text-dark-400">Спасибо за заказ!</p>
            {order.kitchenStatus === "new" && <p className="mt-1 text-xs font-medium text-primary-400">Заказ передан на кухню</p>}
          </div>

          <div className="flex items-center justify-between py-2 text-xs">
            <span className="text-dark-400">Заказ №{order.orderNumber}</span>
            <span className="text-dark-500">
              {new Date(order.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>

          <div className="border-t border-dark-700 py-3 space-y-2">
            {order.items?.map((item) => (
              <div key={item.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-md bg-dark-700 px-1.5 text-[10px] font-bold text-dark-300">
                    {item.quantity}x
                  </span>
                  <span className="text-sm text-dark-300">{item.product?.name}</span>
                </div>
                <span className="text-sm font-semibold text-dark-50">{money(Number(item.totalPrice))}</span>
              </div>
            ))}
          </div>

          <div className="border-t border-dark-700 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-dark-50">ИТОГО</span>
              <span className="text-xl font-bold text-primary-400">{money(Number(order.total))}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs text-dark-500">
              <span>
                {order.payments?.[0]?.method === "card" ? "Карта" : order.payments?.[0]?.method === "qr" ? "QR" : "Наличные"}
              </span>
              <span>{order.type === "dine_in" ? "В зале" : order.type === "takeaway" ? "Навынос" : order.type}</span>
            </div>
          </div>

          <div className="mt-4 rounded bg-dark-700/50 p-3 text-center">
            <p className="text-[11px] font-medium text-primary-400 leading-relaxed">
              {quote}
            </p>
          </div>
        </div>

        <div className="border-t border-dark-700 px-6 py-4 space-y-2.5">
          <div className="flex gap-2.5">
            <button
              onClick={handlePrint}
              disabled={printing}
              className="flex flex-1 items-center justify-center gap-2 rounded border border-dark-600 bg-dark-700 py-3 text-sm font-semibold text-dark-300 transition-all hover:border-dark-500 hover:text-dark-50 active:scale-[0.97] disabled:opacity-50"
            >
              {printing ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-dark-400 border-t-white" />
              ) : (
                <Printer className="h-4 w-4" />
              )}
              Печать
            </button>
            <button
              onClick={handleDownload}
              className="flex flex-1 items-center justify-center gap-2 rounded border border-dark-600 bg-dark-700 py-3 text-sm font-semibold text-dark-300 transition-all hover:border-dark-500 hover:text-dark-50 active:scale-[0.97]"
            >
              <Download className="h-4 w-4" />
              Скачать
            </button>
          </div>
          <button
            onClick={onNewOrder}
            className="flex w-full items-center justify-center gap-2 rounded bg-primary-600 py-3.5 text-sm font-bold text-white transition-all hover:bg-primary-500 active:scale-[0.98]"
          >
            <RotateCcw className="h-4 w-4" />
            Новый заказ
          </button>
        </div>
      </div>
    </div>
  );
}
