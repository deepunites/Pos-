export interface Tenant {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  address: string;
  currency: string;
  taxRate: number;
  settings: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "manager" | "cashier";
  avatarUrl?: string;
  pin?: string;
}

export interface Category {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  description?: string;
  imageUrl?: string;
  color: string;
  sortOrder: number;
  isIngredient: boolean;
  markupPercent: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  children?: Category[];
  _count?: { products: number };
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
  purchaseUnit?: string;
  saleUnit?: string;
  conversionFactor?: number;
  minStock: number;
  currentStock: number;
  trackInventory: boolean;
  isActive: boolean;
  sortOrder: number;
  tags: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  category?: Category;
  modifierGroups?: ModifierGroup[];
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: ModifierItem[];
}

export interface ModifierItem {
  id: string;
  name: string;
  price: number;
}

export interface Table {
  id: string;
  number: string;
  capacity: number;
  status: "available" | "occupied" | "reserved" | "maintenance";
  zone?: string | null;
  orders?: { id: string }[];
}

export interface CartItem {
  id: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
  // Weight in grams for weighed products; the server prices rate × grams
  // (per gram or per kilogram, depending on the product's sale unit).
  grams?: number;
  // Shop register: how a weighed product is priced and at what rate — kept on
  // the line so it can be re-priced when the weight is edited.
  weightUnit?: "г" | "кг";
  rate?: number;
  barcode?: string | null;
  emoji?: string;
  notes?: string;
  modifiers?: { id: string; name: string; price: number }[];
}

export interface Order {
  id: string;
  tenantId: string;
  orderNumber: string;
  type: "dine_in" | "takeaway" | "delivery";
  status: "pending" | "confirmed" | "preparing" | "ready" | "completed" | "cancelled";
  // Кухня — отдельно от оплаты; "new" сразу после продажи в кафе, null — магазин.
  kitchenStatus?: "new" | "cooking" | "ready" | "served" | null;
  tableId?: string;
  table?: { id: string; number: string };
  customerName?: string;
  customerPhone?: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  notes?: string;
  items: OrderItem[];
  payments?: Payment[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  product?: Product;
  quantity: number;
  weightGrams?: number | null;
  unitPrice: number;
  totalPrice: number;
  modifiers?: { modifierItem: { name: string } }[];
}

export interface Payment {
  id: string;
  orderId: string;
  method: "cash" | "card" | "qr";
  amount: number;
  status: "pending" | "completed" | "refunded";
  createdAt: string;
}

export type OrderType = "dine_in" | "takeaway" | "delivery";

export type PaymentMethod = "cash" | "card" | "qr";

export interface CashShift {
  id: string;
  tenantId: string;
  userId: string;
  status: "open" | "closed";
  openingCash: number;
  closingCash?: number;
  totalSales: number;
  totalCashSales: number;
  totalCardSales: number;
  totalQrSales: number;
  /** Продано в долг (в ящик не попало) и погашено долгов на этой кассе. */
  totalDebtSales?: number;
  totalDebtRepaidCash?: number;
  totalDebtRepaidCard?: number;
  totalTips: number;
  totalRefunds: number;
  expectedCash?: number;
  difference?: number;
  notes?: string;
  openedAt: string;
  closedAt?: string;
  user?: { id: string; firstName: string; lastName: string };
  orders?: { id: string; orderNumber: number; total: number; status: string; createdAt: string }[];
  _count?: { orders: number };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
