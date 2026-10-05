import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Grid3X3, List, Package, Pencil, Trash2, ScanBarcode, Upload, Download, ChevronDown } from "lucide-react";
import { useProducts, useDeleteProduct, useCategories } from "../hooks/useProducts";
import SearchInput from "../components/SearchInput";
import Badge from "../components/Badge";
import LoadingSpinner from "../components/LoadingSpinner";
import EmptyState from "../components/EmptyState";
import { useIsRetail } from "../hooks/useSettings";
import ConfirmDialog from "../components/ConfirmDialog";
import type { Product, Category } from "../services";
import { useMoney } from "../hooks/useMoney";
import ImportProductsModal from "../components/ImportProductsModal";
import { productService } from "../services";
import { notify } from "../components/notify";
import { apiErrorMessage } from "../utils/apiError";
import { downloadCsv, downloadTemplate, downloadXlsx } from "../utils/productsFile";

/** «Экспорт ▾»: все товары в Excel или CSV для 1С, пустой шаблон для импорта. */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const run = async (kind: "xlsx" | "csv" | "template") => {
    setOpen(false);
    setBusy(true);
    try {
      if (kind === "template") {
        await downloadTemplate();
        return;
      }
      const products = (await productService.exportAll()).data.data;
      const name = `Товары ${new Date().toLocaleDateString("sv-SE")}`;
      if (kind === "xlsx") await downloadXlsx(products, `${name}.xlsx`);
      else downloadCsv(products, `${name}.csv`);
    } catch (e) {
      notify.error(apiErrorMessage(e, "Не удалось выгрузить товары"));
    } finally {
      setBusy(false);
    }
  };

  const items: { kind: "xlsx" | "csv" | "template"; title: string; hint: string }[] = [
    { kind: "xlsx", title: "Все товары — Excel", hint: "цены, остатки, штрихкоды" },
    { kind: "csv", title: "Все товары — CSV", hint: "для 1С и других программ" },
    { kind: "template", title: "Пустой шаблон для импорта", hint: "колонки и пример строки" },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn-secondary whitespace-nowrap"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        {busy ? <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : <Download className="mr-2 h-4 w-4" />}
        Экспорт
        <ChevronDown className="ml-1 h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 top-full z-20 mt-1 w-72 p-1.5 shadow-lg">
          {items.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              onClick={() => void run(item.kind)}
            >
              <span className="block font-medium text-gray-900">{item.title}</span>
              <span className="block text-xs text-gray-500">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


export default function Products() {
  const { money } = useMoney();
  const retail = useIsRetail();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [categoryId, setCategoryId] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const { data, isLoading } = useProducts({ search, categoryId: categoryId || undefined, limit: 50 });
  const { data: categories } = useCategories();
  const deleteProduct = useDeleteProduct();

  const products: Product[] = data?.data || [];

  const handleDelete = (): void => {
    if (deleteId) {
      deleteProduct.mutate(deleteId, { onSuccess: () => setDeleteId(null) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Товары</h1>
          <p className="text-gray-500">Управление каталогом товаров</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button type="button" onClick={() => setImportOpen(true)} className="btn-secondary whitespace-nowrap" title="Загрузить товары из Excel или CSV — из 1С, другой программы или шаблона">
            <Upload className="mr-2 h-4 w-4" />
            Импорт
          </button>
          <ExportMenu />
          <Link to="/products/scan" aria-label="Добавить сканером" className="btn-secondary whitespace-nowrap" title="Наведите сканер на штрихкод — название подставится из общей базы">
            <ScanBarcode className="mr-2 h-4 w-4" />
            <span className="sm:hidden">Сканер</span>
            <span className="hidden sm:inline">Добавить сканером</span>
          </Link>
          <Link to="/products/new" aria-label="Добавить товар" className="btn-primary whitespace-nowrap">
            <Plus className="mr-2 h-4 w-4" />
            <span className="sm:hidden">Товар</span>
            <span className="hidden sm:inline">Добавить товар</span>
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} className="w-full sm:w-80" placeholder="Поиск товаров..." />
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="input w-full sm:w-48"
        >
          <option value="">Все категории</option>
          {categories?.map((cat: Category) => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
        <div className="flex rounded-lg border border-gray-200">
          <button
            onClick={() => setViewMode("grid")}
            aria-label="Плитками"
            aria-pressed={viewMode === "grid"}
            className={`p-2 ${viewMode === "grid" ? "bg-gray-100 text-gray-900" : "text-gray-500"}`}
          >
            <Grid3X3 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            aria-label="Списком"
            aria-pressed={viewMode === "list"}
            className={`p-2 ${viewMode === "list" ? "bg-gray-100 text-gray-900" : "text-gray-500"}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : products.length === 0 ? (
        <div className="card">
          {search || categoryId ? (
            <EmptyState
              compact
              title={search ? `По запросу «${search}» товаров нет` : "В этой категории товаров нет"}
              description="Проверьте написание или поищите по штрихкоду."
              action={
                <button onClick={() => { setSearch(""); setCategoryId(""); }} className="btn-secondary">
                  Сбросить поиск
                </button>
              }
            />
          ) : retail ? (
            <EmptyState
              compact
              title="Товаров пока нет"
              description="Быстрее всего — сканером: наведите на штрихкод, название и полка подставятся из общей базы, останется ввести цену."
              action={
                <>
                  <Link to="/products/scan" className="btn-primary">
                    <ScanBarcode className="mr-2 h-4 w-4" />
                    Добавить сканером
                  </Link>
                  <Link to="/products/new" className="btn-secondary">
                    <Plus className="mr-2 h-4 w-4" />
                    Вручную
                  </Link>
                  <button type="button" onClick={() => setImportOpen(true)} className="btn-secondary">
                    <Upload className="mr-2 h-4 w-4" />
                    Из Excel / 1С
                  </button>
                </>
              }
            />
          ) : (
            <EmptyState
              compact
              title="Меню пока пустое"
              description="Блюдо — это название, цена и категория. Категории станут клавишами на кассе, блюда — плитками."
              action={
                <Link to="/products/new" className="btn-primary">
                  <Plus className="mr-2 h-4 w-4" />
                  Добавить блюдо
                </Link>
              }
            />
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <div key={product.id} className="card group relative overflow-hidden transition-shadow hover:shadow-md">
              {product.imageUrl ? (
                <img src={product.imageUrl} alt={product.name} className="h-40 w-full rounded-lg object-cover" />
              ) : (
                <div className="flex h-40 w-full items-center justify-center rounded-lg bg-gray-100">
                  <Package className="h-12 w-12 text-gray-300" />
                </div>
              )}
              <div className="mt-3">
                <div className="flex items-start justify-between">
                  <h3 className="font-semibold text-gray-900 line-clamp-1">{product.name}</h3>
                  {product.category && <Badge variant="gray">{product.category.name}</Badge>}
                </div>
                {product.sku && <p className="mt-0.5 text-xs text-gray-500">Артикул: {product.sku}</p>}
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-lg font-bold text-gray-900">{money(product.price)}</span>
                  {product.trackInventory && (
                    <span className={`text-sm ${product.currentStock <= product.minStock ? "text-danger-600 font-medium" : "text-gray-500"}`}>
                      Остаток: {product.currentStock}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-3 flex gap-2 transition-opacity group-focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
                <Link to={`/products/${product.id}`} className="btn-secondary flex-1 text-xs py-1.5">
                  <Pencil className="mr-1 inline h-3 w-3" />
                  Изменить
                </Link>
                <button onClick={() => setDeleteId(product.id)} className="btn-danger flex-1 text-xs py-1.5">
                  <Trash2 className="mr-1 inline h-3 w-3" />
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
        {/* Телефон: одна карточка на товар, главное крупно, остальное парами (D-4). */}
        <div className="card divide-y divide-gray-100 p-0 md:hidden">
          {products.map((product) => {
            const low = product.trackInventory && product.currentStock <= product.minStock;
            const noMargin = product.costPrice > 0 && product.price <= product.costPrice;
            return (
              <div key={product.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt="" className="h-11 w-11 flex-shrink-0 rounded-md object-cover" />
                  ) : (
                    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md bg-gray-100">
                      <Package className="h-5 w-5 text-gray-500" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900">{product.name}</p>
                    <p className="truncate text-xs text-gray-500">{[product.sku, product.category?.name].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  <Badge variant={product.isActive ? "success" : "gray"}>{product.isActive ? "Активен" : "Неактивен"}</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-gray-500">Цена</dt>
                    <dd className="font-semibold text-gray-900">{money(product.price)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">Себестоимость</dt>
                    <dd className="text-gray-700">{money(product.costPrice)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">Остаток</dt>
                    <dd className={`font-semibold ${low ? "text-danger-600" : "text-gray-900"}`}>{product.trackInventory ? product.currentStock : "—"}</dd>
                  </div>
                </dl>
                {noMargin && (
                  <span className="w-fit rounded-md bg-danger-50 px-1.5 py-0.5 text-[11px] font-medium text-danger-600">без маржи — проверьте цену</span>
                )}
                <div className="flex gap-2">
                  <Link to={`/products/${product.id}`} className="btn-secondary flex-1">
                    <Pencil className="mr-2 h-4 w-4" />
                    Изменить
                  </Link>
                  <button onClick={() => setDeleteId(product.id)} className="btn-secondary flex-1 text-danger-600">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Удалить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="card hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="p-4">Товар</th>
                <th className="p-4">Категория</th>
                <th className="p-4">Цена</th>
                <th className="p-4">Себестоимость</th>
                <th className="p-4">Остаток</th>
                <th className="p-4">Статус</th>
                <th className="p-4 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((product) => (
                <tr key={product.id} className="hover:bg-gray-50">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
                          <Package className="h-5 w-5 text-gray-500" />
                        </div>
                      )}
                      <div>
                        <span className="font-medium text-gray-900">{product.name}</span>
                        {product.sku && <p className="text-xs text-gray-500">{product.sku}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-sm text-gray-500">{product.category?.name || "—"}</td>
                  <td className="p-4 whitespace-nowrap font-medium text-gray-900">
                    {money(product.price)}
                    {/* A price at or below cost usually means it was overwritten
                        by a delivery rather than set deliberately. */}
                    {product.costPrice > 0 && product.price <= product.costPrice && (
                      <span
                        className="ml-2 inline-flex items-center rounded-md bg-danger-50 px-1.5 py-0.5 text-[11px] font-medium text-danger-600"
                        title="Цена продажи не выше себестоимости — проверьте цену или наценку категории"
                      >
                        без маржи
                      </span>
                    )}
                  </td>
                  <td className="p-4 whitespace-nowrap text-sm text-gray-500">{money(product.costPrice)}</td>
                  <td className="p-4">
                    <span className={`font-semibold ${product.trackInventory && product.currentStock <= product.minStock ? "text-danger-600" : "text-gray-900"}`}>
                      {product.trackInventory ? product.currentStock : "—"}
                    </span>
                  </td>
                  <td className="p-4">
                    <Badge variant={product.isActive ? "success" : "gray"}>
                      {product.isActive ? "Активен" : "Неактивен"}
                    </Badge>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link to={`/products/${product.id}`} className="text-sm font-medium text-primary-600 hover:text-primary-700">
                        Изменить
                      </Link>
                      <button
                        onClick={() => setDeleteId(product.id)}
                        className="text-sm font-medium text-danger-600 hover:text-danger-700"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {importOpen && <ImportProductsModal onClose={() => setImportOpen(false)} />}

      <ConfirmDialog
        open={!!deleteId}
        danger
        title="Удалить товар?"
        description="Товар пропадёт из каталога и с кассы. Если его ни разу не продавали и не приходовали — удалится насовсем; если продавали — снимется с продажи, а чеки и приходы останутся."
        confirmLabel="Удалить"
        loading={deleteProduct.isPending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
