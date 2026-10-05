import { useQuery } from "@tanstack/react-query";
import api from "./api";

// Права кассира — галочки в карточке сотрудника в админке: продажа в долг,
// приход товара, сумма смены. Запрет держит сервер; касса прячет кнопки,
// чтобы кассир не упирался в отказ. Права приходят при входе и
// перепроверяются: снятая администратором галочка прячет кнопку без перевхода.

export interface Permissions {
  canSellOnDebt: boolean;
  canReceiveStock: boolean;
  canSeeExpectedCash: boolean;
}

const ALL: Permissions = { canSellOnDebt: true, canReceiveStock: true, canSeeExpectedCash: true };

/** Права, сохранённые при входе, поверх них — свежие с сервера. Неизвестное — разрешено: решает сервер. */
export function mergePermissions(saved?: Partial<Permissions>, fresh?: Partial<Permissions>): Permissions {
  return { ...ALL, ...saved, ...fresh };
}

export function usePermissions(saved?: Partial<Permissions>): Permissions {
  const { data } = useQuery({
    queryKey: ["me", "permissions"],
    queryFn: () => api.get("/auth/me").then((r) => r.data.data.permissions as Permissions),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return mergePermissions(saved, data);
}
