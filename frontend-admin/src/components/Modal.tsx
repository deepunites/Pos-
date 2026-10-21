import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import clsx from "clsx";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /**
   * false — окно сейчас не закрыть: идёт запись, и её результат (номер
   * прихода, ключ повтора) живёт в самом окне. Крестик выключен, Escape и
   * клик мимо окна ничего не делают.
   */
  closable?: boolean;
}

const sizeMap = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Модальное окно как диалог (D-6): role="dialog" и заголовок для диктора,
 * Tab не уходит за окно, Escape закрывает, после закрытия фокус возвращается
 * на кнопку, которая окно открыла. Прокрутка страницы под окном выключена.
 */
export default function Modal({ isOpen, onClose, title, children, size = "md", closable = true }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // onClose из родителя часто новая функция на каждый рендер — эффект ниже не
  // должен из-за этого перезапускаться и дёргать фокус.
  const onCloseRef = useRef(onClose);
  const closableRef = useRef(closable);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    closableRef.current = closable;
  });

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    // Первый фокус: элемент с data-autofocus, иначе первое поле, иначе само окно.
    if (dialog && !dialog.contains(document.activeElement)) {
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]");
      const field = dialog.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      (preferred ?? field ?? dialog).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (closableRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 transition-opacity" onClick={closable ? onClose : undefined} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx("relative z-10 mx-4 w-full rounded-md bg-surface shadow-2xl outline-none", sizeMap[size])}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-gray-900">
              {title}
            </h2>
            <button
              onClick={onClose}
              disabled={!closable}
              aria-label="Закрыть"
              title={closable ? undefined : "Подождите — идёт запись"}
              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
