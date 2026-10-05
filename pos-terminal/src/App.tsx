import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import LoginScreen from "./screens/LoginScreen";
import MenuScreen from "./screens/MenuScreen";
import ShopScreen from "./screens/shop/ShopScreen";
import { useMoney } from "./hooks/useMoney";
import PaymentModal from "./screens/PaymentScreen";
import ReceiptModal from "./screens/ReceiptScreen";
import OpenShiftScreen from "./screens/OpenShiftScreen";
import CloseShiftScreen from "./screens/CloseShiftScreen";
import { useCartStore } from "./store/cartStore";
import { ConnectionBar } from "./components/ConnectionStatus";
import UpdateBanner from "./components/UpdateBanner";
import { useConnection } from "./services/connection";
import { flushQueue, loadQueue, onQueueSent, useOfflineQueue, watchQueue } from "./services/offlineQueue";
import { askPersistentStorage } from "./services/offlineDb";
import { refreshCatalog } from "./services/offlineCatalog";
import { sessionClaims } from "./services/session";
import toast from "react-hot-toast";
import { isNoConnection } from "./utils/apiError";
import { disconnectSocket } from "./services/socket";
import api, { clearSession } from "./services/api";
import type { Order, CashShift } from "./types";
import type { Permissions } from "./services/permissions";

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  permissions?: Partial<Permissions>;
}

interface WorkspaceProps {
  user: UserData;
  shift: CashShift;
  onLogout: () => void;
  onCheckout: () => void;
  onCloseShift: () => void;
}

// Which register the point works with follows its type, set in the admin panel.
// A separate component so the settings request only starts once someone is
// signed in — an unauthenticated 401 would make the api client reload the page.
function Workspace({ user, shift, onLogout, onCheckout, onCloseShift }: WorkspaceProps) {
  const { businessType, settingsLoaded } = useMoney();

  if (!settingsLoaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-dark-500 border-t-primary-500" />
      </div>
    );
  }

  if (businessType === "retail") {
    return <ShopScreen user={user} shift={shift} onLogout={onLogout} onCloseShift={onCloseShift} />;
  }
  return <MenuScreen user={user} shift={shift} onLogout={onLogout} onCheckout={onCheckout} onCloseShift={onCloseShift} />;
}

// Полоса связи в рабочем экране: касса магазина без связи продаёт за наличные,
// и полоса говорит об этом (офлайн-режим). Отдельный компонент — настройки
// точки спрашиваются только после входа.
function WorkspaceConnectionBar() {
  const { businessType } = useMoney();
  return <ConnectionBar offlineSales={businessType === "retail"} />;
}

// Смена, известная планшету: без связи после перезагрузки касса продолжает
// работать в ней, а не упирается в «Не удалось проверить смену» (офлайн-режим).
const SHIFT_KEY = "pos-shift";

function rememberShift(userId: string, shift: CashShift | null): void {
  try {
    if (shift) localStorage.setItem(SHIFT_KEY, JSON.stringify({ userId, shift }));
    else localStorage.removeItem(SHIFT_KEY);
  } catch {
    // без хранилища — просто без офлайн-копии
  }
}

function rememberedShift(userId: string): CashShift | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SHIFT_KEY) || "null");
    return saved && saved.userId === userId ? (saved.shift as CashShift) : null;
  } catch {
    return null;
  }
}

// Сохранённая сессия планшета: читается один раз при запуске, в начальном
// значении состояния, а не эффектом после первого рендера.
function savedSession(): { token: string; user: UserData } | null {
  const token = localStorage.getItem("pos-token");
  const user = localStorage.getItem("pos-user");
  if (!token || !user) return null;
  try {
    return { token, user: JSON.parse(user) as UserData };
  } catch {
    localStorage.removeItem("pos-user");
    return null;
  }
}

function App() {
  const [user, setUser] = useState<UserData | null>(() => savedSession()?.user ?? null);
  const [token, setToken] = useState<string | null>(() => savedSession()?.token ?? null);
  const [showPayment, setShowPayment] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);
  const [currentShift, setCurrentShift] = useState<CashShift | null>(null);
  // С первого кадра после входа — «Загрузка», а не мелькнувшее «Открытие смены».
  const [shiftLoading, setShiftLoading] = useState(() => savedSession() !== null);
  const [showCloseShift, setShowCloseShift] = useState(false);
  // Смену не удалось проверить (нет связи) — это не «смены нет»: открывать
  // вторую нельзя. Счётчик перезапускает проверку.
  const [shiftUnknown, setShiftUnknown] = useState(false);
  const [shiftCheck, setShiftCheck] = useState(0);
  // Смена взята из памяти планшета, потому что сервер не ответил, — сверить, когда связь вернётся.
  const [shiftFromMemory, setShiftFromMemory] = useState(false);
  const connected = useConnection((s) => s.problem === null);
  const clearCart = useCartStore((s) => s.clearCart);
  const queryClient = useQueryClient();

  // Связь вернулась — проверить смену ещё раз, без нажатий.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- повтор проверки при возврате связи
    if (connected && (shiftUnknown || shiftFromMemory)) setShiftCheck((n) => n + 1);
  }, [connected, shiftUnknown, shiftFromMemory]);

  // Офлайн-режим: очередь чеков этой точки — с планшета; отправляется сама,
  // при возврате связи и по таймеру. После отправки — свежий каталог и остатки.
  useEffect(() => {
    if (!token || !user) return;
    const tenantId = sessionClaims()?.tenantId;
    if (!tenantId) return;
    void loadQueue(tenantId).then(() => {
      if (!useConnection.getState().problem) void flushQueue();
    });
    watchQueue();
    askPersistentStorage();
    return onQueueSent((sent) => {
      toast.success(sent === 1 ? "Чек, пробитый без связи, отправлен" : `Чеки, пробитые без связи, отправлены: ${sent}`, { id: "offline-sent" });
      void refreshCatalog();
      void queryClient.invalidateQueries();
    });
  }, [token, user, queryClient]);

  // Check for active shift after login
  useEffect(() => {
    if (!token || !user) return;
    // Флаг загрузки ставится вместе с запуском запроса; смену дальше меняют и
    // обработчики открытия/закрытия, поэтому она в состоянии, а не в useQuery.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- начало загрузки при входе
    setShiftLoading(true);
    api
      .get("/cash-shifts/current")
      .then((res) => {
        setCurrentShift(res.data.data || null);
        rememberShift(user.id, res.data.data || null);
        setShiftUnknown(false);
        setShiftFromMemory(false);
      })
      .catch((error) => {
        if (isNoConnection(error)) {
          const remembered = rememberedShift(user.id);
          if (remembered) {
            setCurrentShift(remembered);
            setShiftFromMemory(true);
            setShiftUnknown(false);
          } else {
            setShiftUnknown(true);
          }
          return;
        }
        setCurrentShift(null);
        setShiftUnknown(false);
      })
      .finally(() => {
        setShiftLoading(false);
      });
  }, [token, user, shiftCheck]);

  // Кэш запросов — данные прошлой сессии: настройки точки (тип кассы, валюта,
  // название), товары, смена. После «Сменить точку» без перезагрузки касса
  // иначе открывалась бы магазином с чужой валютой.
  const handleLogin = (userData: UserData, userToken: string): void => {
    queryClient.clear();
    setShiftLoading(true);
    setUser(userData);
    setToken(userToken);
    localStorage.setItem("pos-user", JSON.stringify(userData));
  };

  const handleLogout = (): void => {
    disconnectSocket();
    queryClient.clear();
    setUser(null);
    setToken(null);
    setCurrentShift(null);
    clearSession();
    clearCart();
  };

  const handleShiftOpened = (shift: CashShift): void => {
    setCurrentShift(shift);
    if (user) rememberShift(user.id, shift);
  };

  // Смену с неотправленными чеками не закрыть: её итоги без них были бы неверны.
  const handleCloseShift = (): void => {
    const waiting = useOfflineQueue.getState().items.length;
    if (waiting > 0) {
      toast.error(`Сначала должны уйти чеки, пробитые без связи (${waiting}). Дождитесь связи — они отправятся сами.`, { duration: 6000 });
      return;
    }
    setShowCloseShift(true);
  };

  const handleShiftClosed = (): void => {
    setCurrentShift(null);
    if (user) rememberShift(user.id, null);
    setShowCloseShift(false);
    handleLogout();
  };

  // Not logged in
  if (!token || !user) {
    return (
      <>
        <ConnectionBar floating />
        <LoginScreen onLogin={handleLogin} />
      </>
    );
  }

  // Loading shift state
  if (shiftLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-dark-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-dark-500 border-t-primary-500" />
          <p className="text-sm text-dark-400">Загрузка...</p>
        </div>
      </div>
    );
  }

  // Не удалось спросить сервер — смена может быть открыта; ждём связь.
  if (shiftUnknown && !currentShift) {
    return (
      <>
        <ConnectionBar floating />
        <div className="flex h-screen items-center justify-center bg-dark-950 px-6">
          <div className="max-w-sm text-center">
            <p className="text-lg font-semibold text-dark-50">Не удалось проверить смену</p>
            <p className="mt-2 text-sm text-dark-400">
              Нет связи с сервером. Смена, скорее всего, открыта — касса проверит её сама, как только связь вернётся.
            </p>
            <button
              onClick={() => setShiftCheck((n) => n + 1)}
              className="mt-6 min-h-11 rounded-md bg-primary-600 px-6 text-sm font-semibold text-white hover:bg-primary-500"
            >
              Проверить сейчас
            </button>
          </div>
        </div>
      </>
    );
  }

  // No shift open — require opening one
  if (!currentShift) {
    return (
      <>
        <ConnectionBar floating />
        <OpenShiftScreen user={user} onShiftOpened={handleShiftOpened} />
      </>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-dark-950">
      {/* В потоке, а не поверх: кнопки оплаты внизу экрана не закрываются. */}
      <UpdateBanner />
      <WorkspaceConnectionBar />
      <Workspace
        user={user}
        shift={currentShift}
        onLogout={handleLogout}
        onCheckout={() => setShowPayment(true)}
        onCloseShift={handleCloseShift}
      />

      {showPayment && (
        <PaymentModal
          shiftId={currentShift.id}
          onComplete={(order) => {
            setCompletedOrder(order);
            setShowPayment(false);
            setShowReceipt(true);
          }}
          onClose={() => setShowPayment(false)}
        />
      )}

      {showReceipt && completedOrder && (
        <ReceiptModal
          order={completedOrder}
          onNewOrder={() => {
            setCompletedOrder(null);
            setShowReceipt(false);
          }}
        />
      )}

      {showCloseShift && (
        <CloseShiftScreen
          shiftId={currentShift.id}
          onShiftClosed={handleShiftClosed}
          onCancel={() => setShowCloseShift(false)}
        />
      )}
    </div>
  );
}

export default App;
