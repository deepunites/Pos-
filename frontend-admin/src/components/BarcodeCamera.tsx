import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";

interface BarcodeCameraProps {
  onDetected: (code: string) => void;
  onClose: () => void;
}

/**
 * Штрихкод с камеры телефона или ноутбука. Распознавание — @zxing/browser:
 * работает и в Chrome, и в Safari на iPhone; библиотека грузится только
 * когда окно открыли, в основной бандл админки она не попадает.
 */
export default function BarcodeCamera({ onDetected, onClose }: BarcodeCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Колбэк в ref — иначе каждая перерисовка родителя перезапускала бы камеру.
  const detected = useRef(onDetected);
  useEffect(() => {
    detected.current = onDetected;
  });

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | undefined;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (stopped || !videoRef.current) return;
        controls = await new BrowserMultiFormatReader().decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current,
          (result) => {
            if (!result || stopped) return;
            stopped = true;
            controls?.stop();
            detected.current(result.getText());
          }
        );
        if (stopped) controls.stop();
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Браузер не дал доступ к камере — разрешите его в настройках сайта"
            : "Камера недоступна — введите штрихкод вручную или сканером"
        );
      }
    })();
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, []);

  return (
    <Modal isOpen onClose={onClose} title="Наведите камеру на штрихкод" size="md">
      <div className="space-y-3">
        <video ref={videoRef} className="aspect-video w-full rounded-md bg-black object-cover" muted playsInline />
        <p className="text-sm text-gray-500">{error ?? "Держите штрихкод в кадре — он подставится сам."}</p>
      </div>
    </Modal>
  );
}
