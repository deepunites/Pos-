import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import ProductEdit from "./pages/ProductEdit";
import ScanAdd from "./pages/ScanAdd";
import Orders from "./pages/Orders";
import OrderDetail from "./pages/OrderDetail";
import Payments from "./pages/Payments";
import Inventory from "./pages/Inventory";
import StockReceipts from "./pages/StockReceipts";
import Customers from "./pages/Customers";
import CashShifts from "./pages/CashShifts";
import Users from "./pages/Users";
import Categories from "./pages/Categories";
import Tables from "./pages/Tables";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import Kitchen from "./pages/Kitchen";
import TechCards from "./pages/TechCards";
import LoadingSpinner from "./components/LoadingSpinner";

// Витрина интерфейса нужна только администратору — отдельным файлом, не в общей сборке.
const DesignSystem = lazy(() => import("./pages/DesignSystem"));

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tech-cards" element={<TechCards />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<ProductEdit />} />
        <Route path="/products/scan" element={<ScanAdd />} />
        <Route path="/products/:id" element={<ProductEdit />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/payments" element={<Payments />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/stock-receipts" element={<StockReceipts />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/cash-shifts" element={<CashShifts />} />
        <Route path="/users" element={<Users />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/tables" element={<Tables />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/kitchen" element={<Kitchen />} />
        <Route
          path="/_design"
          element={
            <Suspense fallback={<LoadingSpinner />}>
              <DesignSystem />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  );
}
