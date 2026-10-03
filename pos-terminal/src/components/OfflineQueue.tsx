import { useState } from "react";
import { AlertTriangle, CloudUpload, RotateCw, X } from "lucide-react";
import { attentionCount, flushQueue, pendingCount, retrySale, useOfflineQueue, type QueuedSale } from "../services/offlineQueue";
import { useConnection } from "../services/connection";
import { useMoney } from "../hooks/useMoney";
import { useEscape } from "../screens/shop/Modals";

const when = (ts: number) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}, ${time}`;
};

const summary = (sale: QueuedSale) =>
  sale.lines
    .map((l) => (l.grams ? `${l.name} ${(l.grams / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг` : l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name))
    .join(", ");

/**
 * Метка в шапке кассы магазина: сколько чеков, пробитых без связи, ещё не на
 * сервере. Видна, только пока такие есть; по нажатию — список.
 */
export function OfflineQueueChip() {
  const state = useOfflineQueue();
  const pending = pendingCount(state);
  const attention = attentionCount(state);
  const [open, setOpen] = useState(false);
  if (pending === 0 && attention === 0 && !open) return null;

  const label = state.syncing ? `Отправляю чеки… ${state.sentNow}` : attention ? `Не приняты: ${attention}` : `Не отправлено: ${pending}`;
  return (
    <>
      <button className={`sh-chip sh-chip-queue${attention ? " bad" : ""}`} onClick={() => setOpen(true)} title="Чеки, пробитые без связи">
        {attention ? <AlertTriangle className="i" /> : <CloudUpload className="i" />}
        {label}
      </button>
      {open && <OfflineQueueModal onClose={() => setOpen(false)} />}
    </>
  );
}

function OfflineQueueModal({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const { items, syncing } = useOfflineQueue();
  const online = useConnection((s) => s.problem === null);
  const { money } = useMoney();

  return (
    <div className="sh-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sh-modal" role="dialog" aria-label="Чеки без связи">
        <div className="sh-mh">
          <div className="emo">
            <CloudUpload className="i" />
          </div>
          <div>
            <h3>Чеки, пробитые без связи</h3>
            <p>{online ? "Уходят на сервер сами, по одному" : "Уйдут на сервер сами, когда вернётся связь"}</p>
          </div>
          <button className="sh-ic" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="sh-empty" style={{ padding: "28px 0" }}>
            <b>Все чеки отправлены</b>
          </div>
        ) : (
          <div className="sh-list">
            {items.map((sale) => (
              <div className="sh-li" key={sale.id}>
                <div className="t">
                  <b className="tab">
                    {when(sale.soldAt)} · {money(sale.total)} · наличные
                  </b>
                  <span>{summary(sale)}</span>
                  {sale.status === "attention" ? (
                    <span className="sh-q-err">Сервер не принял: {sale.error}</span>
                  ) : (
                    <span className="sh-q-wait">{syncing ? "Отправляется…" : "Ждёт отправки"}</span>
                  )}
                </div>
                {sale.status === "attention" && (
                  <button className="back" onClick={() => void retrySale(sale.id)} disabled={!online || syncing}>
                    <RotateCw className="i" style={{ width: 14, height: 14, marginRight: 6 }} />
                    Повторить
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="sh-q-note">
          Чеки хранятся на этом планшете. Не очищайте данные браузера и не меняйте планшет, пока они не отправлены.
        </p>
        <div className="sh-ma">
          <button className="cancel" onClick={onClose}>
            Закрыть
          </button>
          <button className="ok" onClick={() => void flushQueue()} disabled={!online || syncing || items.every((i) => i.status !== "pending")}>
            <CloudUpload className="i" />
            {syncing ? "Отправляю…" : online ? "Отправить сейчас" : "Нет связи"}
          </button>
        </div>
      </div>
    </div>
  );
}
