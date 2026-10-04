import { RefreshCw } from "lucide-react";
import { reloadNow, useAppUpdate } from "../services/appUpdate";

/** Полоса «вышла новая версия»: касса обновится сама, когда чек пуст, — или сейчас, по кнопке. */
export default function UpdateBanner() {
  const ready = useAppUpdate((s) => s.ready);
  if (!ready) return null;
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-3 bg-primary-600 px-4 py-1.5 text-sm text-white">
      <RefreshCw className="h-4 w-4" />
      <span>Вышла новая версия кассы — обновится сама, когда чек будет пуст.</span>
      <button onClick={reloadNow} className="rounded bg-white/15 px-2.5 py-0.5 font-semibold hover:bg-white/25">
        Обновить сейчас
      </button>
    </div>
  );
}
