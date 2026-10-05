import { useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Users,
  BarChart3,
  Settings,
  Tags,
  Warehouse,
  Grid3X3,
  CreditCard,
  ChevronLeft,
  X,
  Store,
  FileText,
  Clock,
  ChefHat,
  Utensils,
  Contact,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useAuthStore } from "../store/authStore";
import { canOpenPath, isRestaurantOnly } from "../utils/access";
import { useSettings } from "../hooks/useSettings";
import clsx from "clsx";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Дашборд" },
  { to: "/products", icon: Package, label: "Товары" },
  { to: "/tech-cards", icon: ChefHat, label: "Тех карты" },
  { to: "/categories", icon: Tags, label: "Категории" },
  { to: "/orders", icon: ShoppingCart, label: "Заказы" },
  { to: "/kitchen", icon: Utensils, label: "Кухня" },
  { to: "/payments", icon: CreditCard, label: "Оплаты" },
  { to: "/inventory", icon: Warehouse, label: "Склад" },
  { to: "/stock-receipts", icon: FileText, label: "Приходы" },
  { to: "/customers", icon: Contact, label: "Клиенты" },
  { to: "/cash-shifts", icon: Clock, label: "Смены" },
  { to: "/tables", icon: Grid3X3, label: "Столы" },
  { to: "/users", icon: Users, label: "Сотрудники" },
  { to: "/reports", icon: BarChart3, label: "Отчёты" },
  { to: "/settings", icon: Settings, label: "Настройки" },
];

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar, mobileNavOpen, setMobileNavOpen } = useUIStore();
  const user = useAuthStore((s) => s.user);
  // Повару из всего меню положена одна «Кухня» — остальное не показываем,
  // чтобы он не упирался в пункты, которые всё равно не откроются.
  // Магазину не нужны тех карты, категории, кухня и столы. Пока тип точки
  // неизвестен, их тоже не показываем — иначе у магазина пункты мелькнут и
  // пропадут. Повару «Кухня» нужна всегда: это его единственная страница.
  const { data: settings, isPending } = useSettings();
  const hideRestaurant = user?.role !== "kitchen" && (isPending || settings?.businessType === "retail");
  const items = navItems.filter((item) => canOpenPath(user?.role, item.to) && !(hideRestaurant && isRestaurantOnly(item.to)));
  const userInitial = user?.firstName?.[0] || user?.email?.[0] || "U";
  const userName = user ? `${user.firstName} ${user.lastName}` : "Пользователь";
  const userEmail = user?.email || "";
  // Свернуть до иконок можно только на широком экране; на телефоне меню
  // выезжает целиком, с подписями.
  const collapsed = !sidebarOpen;
  const label = collapsed ? "lg:hidden" : undefined;

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen, setMobileNavOpen]);

  return (
    <aside
      id="app-nav"
      aria-label="Главное меню"
      className={clsx(
        "fixed left-0 top-0 z-40 flex h-screen w-64 flex-col bg-bar-2 text-bar-fg transition-[width,transform] duration-300 lg:visible lg:translate-x-0",
        mobileNavOpen ? "translate-x-0" : "-translate-x-full max-lg:invisible",
        sidebarOpen ? "lg:w-64" : "lg:w-20"
      )}
    >
      <div className="flex h-14 items-center justify-between bg-bar px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bar-active">
            <Store className="h-5 w-5 text-white" />
          </div>
          <span className={clsx("text-lg font-semibold text-white", label)}>Qwik</span>
        </div>
        <button
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}
          className="hidden rounded p-1.5 text-bar-muted hover:bg-bar-hover hover:text-white lg:block"
        >
          <ChevronLeft className={clsx("h-5 w-5 transition-transform", collapsed && "rotate-180")} />
        </button>
        <button
          onClick={() => setMobileNavOpen(false)}
          aria-label="Закрыть меню"
          className="flex h-10 w-10 items-center justify-center rounded text-bar-muted hover:bg-bar-hover hover:text-white lg:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors lg:py-2.5",
                isActive ? "bg-bar-active text-white" : "text-bar-fg hover:bg-bar-hover hover:text-white"
              )
            }
          >
            <item.icon className="h-5 w-5 flex-shrink-0" />
            <span className={label}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className={clsx("flex items-center gap-3", collapsed && "lg:justify-center")}>
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-bar-active text-sm font-semibold text-white">
            {userInitial}
          </div>
          <div className={clsx("min-w-0", label)}>
            <p className="truncate text-sm font-medium text-white">{userName}</p>
            <p className="truncate text-xs text-bar-muted">{userEmail}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
