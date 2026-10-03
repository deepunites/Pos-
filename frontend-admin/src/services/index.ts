import api from "./api";

export interface LoginResponse {
  user: { id: string; firstName: string; lastName: string; email: string; role: string };
  accessToken: string;
  refreshToken: string;
}

export interface TechCardItem {
  ingredientId: string;
  quantity: number;
  unit: string;
  grossWeight?: number;
  netWeight?: number;
}

export interface TechCard {
  id: string;
  tenantId: string;
  name: string;
  ingredients: string;
  totalCost: number;
  output: number;
  unit: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  products?: { id: string; name: string; price?: number }[];
}

export interface Product {
  id: string;
  tenantId: string;
  categoryId: string;
  name: string;
  description?: string;
  volume?: string;
  sku: string;
  barcode?: string;
  imageUrl?: string;
  price: number;
  costPrice: number;
  compareAtPrice?: number;
  taxRate: number;
  unit: string;
  minStock: number;
  currentStock: number;
  trackInventory: boolean;
  isIngredient: boolean;
  techCardId?: string;
  techCardRef?: TechCard;
  techCard: string;
  preparationArea?: string;
  cookingMethod?: string;
  noDiscounts?: boolean;
  isActive: boolean;
  sortOrder: number;
  tags: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  category?: Category;
  // Единицы и пересчёт закупки в продажу: «покупаем кг, продаём г».
  purchaseUnit?: string | null;
  saleUnit?: string | null;
  conversionFactor?: number | null;
}

export interface Ingredient {
  id: string;
  name: string;
  sku: string;
  costPrice: number;
  currentStock: number;
  unit: string;
  purchaseUnit?: string;
  saleUnit?: string;
}

export interface Category {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  imageUrl?: string;
  color: string;
  sortOrder: number;
  isIngredient: boolean;
  markupPercent: number;
  isActive: boolean;
  _count?: { products: number };
}

export interface Order {
  id: string;
  orderNumber: string;
  type: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  customerName?: string;
  customerPhone?: string;
  tableId?: string;
  table?: { id: string; number: string };
  notes?: string;
  discountAmount?: number;
  payments?: { id: string; method: string; amount: number; status: string }[];
  createdAt: string;
  updatedAt?: string;
  // Кухня — отдельно от оплаты: new → cooking → ready → served; null — кухня не участвует.
  kitchenStatus?: "new" | "cooking" | "ready" | "served" | null;
  // Когда сменился кухонный шаг — по нему видно, сколько готовый заказ ждёт выдачи.
  kitchenStatusAt?: string | null;
  // Пробит на кассе без связи (офлайн-режим магазина): когда; склад ушёл в минус; цена отличалась от каталога.
  offlineAt?: string | null;
  offlineShortfall?: boolean;
  offlinePriceChanged?: boolean;
  items: OrderItem[];
  user?: { id: string; firstName: string; lastName?: string } | null;
}

export interface OrderItemModifier {
  id: string;
  price: number;
  modifierItem?: { id: string; name: string } | null;
}

export interface OrderItem {
  id: string;
  productId: string;
  product?: Product;
  quantity: number;
  weightGrams?: number | null;
  unitPrice: number;
  totalPrice: number;
  notes?: string | null;
  modifiers?: OrderItemModifier[];
}

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  isActive: boolean;
  phone?: string | null;
  // Есть ли вход на кассе по PIN; сам PIN (хеш) сервер не отдаёт.
  hasPin?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface Payment {
  id: string;
  orderId: string;
  method: string;
  amount: number;
  tipAmount: number;
  status: string;
  createdAt: string;
  order?: { id: string; orderNumber: string | number } | null;
}

export interface Table {
  id: string;
  number: string;
  capacity: number;
  zone?: string | null;
  status: string;
  orders?: Order[];
}

export interface TableStats {
  total: number;
  available: number;
  occupied: number;
  reserved: number;
}

export interface DashboardStats {
  todayOrders: number;
  todayRevenue: number;
  weekRevenue: number;
  monthRevenue: number;
  activeOrders: number;
  totalProducts: number;
  lowStockProducts: number;
  recentOrders: Order[];
}

export interface SalesReport {
  totalRevenue: number;
  totalTips: number;
  totalTransactions: number;
  ordersByType: { type: string; _count: number; _sum: { total: number | null } }[];
  topProducts: { productId: string; _count: number; _sum: { quantity: number | null; totalPrice: number | null } }[];
  salesByHour: { hour: string; order_count: number; revenue: number }[];
}

export interface EmployeeReportRow {
  id: string;
  name: string;
  role: string;
  ordersCount: number;
  totalSales: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

export interface RegisterInput {
  tenantName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
  businessType?: "cafe" | "retail";
}

export const authService = {
  login: (email: string, password: string, tenantId?: string) =>
    api.post<ApiResponse<LoginResponse>>("/auth/login", { email, password }, { headers: tenantId ? { "x-tenant-id": tenantId } : {} }),
  register: (data: RegisterInput) => api.post<ApiResponse<LoginResponse>>("/auth/register", data),
  refreshToken: (refreshToken: string) => api.post("/auth/refresh", { refreshToken }),
  me: () => api.get("/auth/me"),
};

// Что панель отправляет при создании и правке товара: теги — массивом (сервер
// хранит их JSON-строкой), техкарту можно отвязать (null).
export type ProductInput = Omit<Partial<Product>, "tags" | "techCardId"> & {
  tags?: string[];
  techCardId?: string | null;
  techCard?: string;
};

export const productService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<Product[]>>("/products", { params }),
  get: (id: string) => api.get<ApiResponse<Product>>(`/products/${id}`),
  create: (data: ProductInput) => api.post<ApiResponse<Product>>("/products", data),
  update: (id: string, data: ProductInput) => api.put<ApiResponse<Product>>(`/products/${id}`, data),
  delete: (id: string) => api.delete(`/products/${id}`),
  adjustStock: (id: string, data: { quantity: number; reason: string }) =>
    api.post(`/products/${id}/stock`, data),
  getIngredients: () => api.get<ApiResponse<Ingredient[]>>("/products/ingredients"),
  getTechCardCost: (id: string) => api.get<ApiResponse<{ cost: number }>>(`/products/${id}/tech-card-cost`),
};

/** What the shared barcode catalogue knows about a code — GET /catalog/lookup. */
export interface CatalogHit {
  found: true;
  barcode: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  category: string | null;
  displayName: string;
  /** the 17-digit code of the national tax catalogue (tasnif.soliq.uz) — what an invoice and a receipt need */
  ikpu: string | null;
  source: "snapshot" | "off" | "crowd" | "tasnif";
}
export type CatalogAnswer = CatalogHit | { found: false; barcode: string; valid: boolean };

export interface CatalogAddInput {
  barcode: string;
  name: string;
  price: number;
  categoryId?: string;
  categoryName?: string;
  weighed?: boolean;
  stock?: number;
  /** the IKPU the lookup showed; kept with the product for invoices and receipts */
  ikpu?: string;
}

export const catalogService = {
  // `national` is the record this browser fetched from tasnif.soliq.uz (see utils/national.ts).
  lookup: (code: string, national?: Record<string, unknown> | null) =>
    api.post<ApiResponse<CatalogAnswer>>("/catalog/lookup", { code, ...(national ? { national } : {}) }),
  add: (data: CatalogAddInput) => api.post<ApiResponse<Product>>("/catalog/add", data),
  stats: () => api.get<ApiResponse<{ total: number; crowd: number }>>("/catalog/stats"),
};

export const orderService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<Order[]>>("/orders", { params }),
  get: (id: string) => api.get<ApiResponse<Order>>(`/orders/${id}`),
  updateStatus: (id: string, status: string) => api.patch(`/orders/${id}/status`, { status }),
  cancel: (id: string) => api.post(`/orders/${id}/cancel`),
  getActive: () => api.get<ApiResponse<Order[]>>("/orders/active"),
  create: (data: Record<string, unknown>) => api.post("/orders", data),
};

export const paymentService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<Payment[]>>("/payments", { params }),
  getSummary: (params?: Record<string, string | number | boolean | undefined>) => api.get("/payments/summary", { params }),
};

export const categoryService = {
  list: () => api.get<ApiResponse<Category[]>>("/categories"),
  get: (id: string) => api.get<ApiResponse<Category>>(`/categories/${id}`),
  create: (data: { name: string; color: string; description?: string; imageUrl?: string; isIngredient?: boolean; markupPercent?: number }) => api.post<ApiResponse<Category>>("/categories", data),
  update: (id: string, data: { name: string; color: string; description?: string; imageUrl?: string; isIngredient?: boolean; markupPercent?: number }) => api.put<ApiResponse<Category>>(`/categories/${id}`, data),
  delete: (id: string) => api.delete(`/categories/${id}`),
};

export const userService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<User[]>>("/users", { params }),
  get: (id: string) => api.get<ApiResponse<User>>(`/users/${id}`),
  // pin: 4–10 цифр для входа на кассе по имени. Пустая строка при
  // обновлении снимает PIN, отсутствие поля — оставляет как было.
  create: (data: { email: string; password: string; firstName: string; lastName: string; role: string; pin?: string }) => api.post("/users", data),
  update: (id: string, data: Partial<User> & { password?: string; pin?: string }) => api.put(`/users/${id}`, data),
  delete: (id: string) => api.delete(`/users/${id}`),
  toggleActive: (id: string) => api.post(`/users/${id}/toggle`),
};

export const inventoryService = {
  getStock: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<Product[]>>("/inventory/stock", { params }),
  getAlerts: () => api.get<ApiResponse<Product[]>>("/inventory/alerts"),
  adjustStock: (id: string, data: { quantity: number; reason: string }) => api.post(`/inventory/${id}/adjust`, data),
};

export const reportService = {
  getDashboard: () => api.get<ApiResponse<DashboardStats>>("/reports/dashboard"),
  getSales: (params: Record<string, string>) => api.get<ApiResponse<SalesReport>>("/reports/sales", { params }),
  getEmployees: (params: Record<string, string>) => api.get<ApiResponse<EmployeeReportRow[]>>("/reports/employees", { params }),
};

export const tableService = {
  list: () => api.get<ApiResponse<Table[]>>("/tables"),
  get: (id: string) => api.get<ApiResponse<Table>>(`/tables/${id}`),
  create: (data: { number: string; capacity: number; zone: string }) => api.post("/tables", data),
  update: (id: string, data: Record<string, unknown>) => api.put(`/tables/${id}`, data),
  updateStatus: (id: string, status: string) => api.patch(`/tables/${id}/status`, { status }),
  delete: (id: string) => api.delete(`/tables/${id}`),
  getStats: () => api.get<ApiResponse<TableStats>>("/tables/stats"),
};

export const settingsService = {
  get: () => api.get("/settings"),
  update: (data: Record<string, unknown>) => api.put("/settings", data),
};

export const stockReceiptService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get("/stock-receipts", { params }),
  get: (id: string) => api.get(`/stock-receipts/${id}`),
  create: (data: { supplierName?: string; invoiceNumber?: string; notes?: string; items: { productId: string; quantity: number; costPrice: number }[] }) =>
    api.post("/stock-receipts", data),
  delete: (id: string) => api.delete(`/stock-receipts/${id}`),
};

export const cashShiftService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get("/cash-shifts", { params }),
  get: (id: string) => api.get(`/cash-shifts/${id}`),
  getCurrent: () => api.get("/cash-shifts/current"),
  open: (data: { openingCash: number; notes?: string }) => api.post("/cash-shifts/open", data),
  close: (id: string, data: { closingCash: number; notes?: string }) => api.post(`/cash-shifts/${id}/close`, data),
};

export const techCardService = {
  list: (params?: Record<string, string | number | boolean | undefined>) => api.get<ApiResponse<TechCard[]>>("/tech-cards", { params }),
  get: (id: string) => api.get<ApiResponse<TechCard>>(`/tech-cards/${id}`),
  create: (data: { name: string; ingredients?: TechCardItem[]; output?: number; unit?: string }) =>
    api.post<ApiResponse<TechCard>>("/tech-cards", data),
  update: (id: string, data: Partial<{ name: string; ingredients: TechCardItem[]; output: number; unit: string }>) =>
    api.put<ApiResponse<TechCard>>(`/tech-cards/${id}`, data),
  delete: (id: string) => api.delete(`/tech-cards/${id}`),
  copy: (id: string) => api.post<ApiResponse<TechCard>>(`/tech-cards/${id}/copy`),
  recalculate: (id: string) => api.post<ApiResponse<TechCard>>(`/tech-cards/${id}/recalculate`),
};

// Клиенты заведения и их долги (касса продаёт в долг, админка смотрит,
// оценивает и принимает погашения).
export type DebtLabel = "ok" | "warn" | "blocked";

export interface Customer {
  id: string;
  firstName: string;
  lastName?: string | null;
  phone: string;
  phone2?: string | null;
  rating?: number | null;
  note?: string | null;
  debtBlocked: boolean;
  debtBalance: number;
  label: DebtLabel;
  debtSince?: string | null;
  debtDays: number;
  createdAt: string;
}

export interface CustomerDebtEntry {
  id: string;
  type: "sale" | "repayment" | "refund";
  amount: number;
  method?: "cash" | "card" | null;
  cashShiftId?: string | null;
  note?: string | null;
  createdAt: string;
  order?: { id: string; orderNumber: number; total: number } | null;
}

export interface CustomerSummary {
  customers: number;
  debtors: number;
  totalDebt: number;
  overdueDebt: number;
}

export type CustomerInput = { firstName: string; lastName?: string | null; phone: string; phone2?: string | null };

export const customerService = {
  list: (params?: { search?: string; withDebt?: boolean; limit?: number }) => api.get<ApiResponse<Customer[]>>("/customers", { params }),
  summary: () => api.get<ApiResponse<CustomerSummary>>("/customers/summary"),
  get: (id: string) => api.get<ApiResponse<Customer & { history: CustomerDebtEntry[] }>>(`/customers/${id}`),
  create: (data: CustomerInput) => api.post<ApiResponse<Customer>>("/customers", data),
  update: (id: string, data: Partial<CustomerInput> & { rating?: number | null; note?: string | null; debtBlocked?: boolean }) =>
    api.patch<ApiResponse<Customer>>(`/customers/${id}`, data),
  repay: (id: string, data: { amount: number; method: "cash" | "card"; note?: string }, idempotencyKey: string) =>
    api.post(`/customers/${id}/repayments`, data, { headers: { "Idempotency-Key": idempotencyKey } }),
};

