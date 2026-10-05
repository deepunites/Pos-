import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { productService, categoryService } from "../services";
import type { ProductInput, Category, Ingredient } from "../services";

interface ProductParams {
  search?: string;
  categoryId?: string;
  limit?: number;
  isActive?: boolean;
}

export function useProducts(params?: ProductParams) {
  return useQuery({
    queryKey: ["products", params],
    queryFn: () => productService.list(params as Record<string, string | number | boolean | undefined>).then((r) => r.data),
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: ["product", id],
    queryFn: () => productService.get(id).then((r) => r.data.data),
    enabled: !!id,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProductInput) => productService.create(data).then((r) => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Товар создан");
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      toast.error(error.response?.data?.error || "Не удалось создать товар");
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProductInput }) =>
      productService.update(id, data).then((r) => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Товар обновлён");
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      toast.error(error.response?.data?.error || "Не удалось обновить товар");
    },
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => productService.delete(id),
    // Без продаж и приходов товар стирается насовсем, с историей — снимается с продажи.
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success(res.data?.data?.removed === "archived" ? "Товар снят с продажи — история чеков и приходов сохранена" : "Товар удалён");
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      toast.error(error.response?.data?.error || "Не удалось удалить товар");
    },
  });
}

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => categoryService.list().then((r) => r.data.data),
  });
}

export function useIngredients() {
  return useQuery<Ingredient[]>({
    queryKey: ["ingredients"],
    queryFn: () => productService.getIngredients().then((r) => r.data.data),
  });
}

export function useTechCardCost(productId: string) {
  return useQuery<{ cost: number }>({
    queryKey: ["techCardCost", productId],
    queryFn: () => productService.getTechCardCost(productId).then((r) => r.data.data),
    enabled: !!productId,
  });
}
