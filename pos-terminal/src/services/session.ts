/**
 * Кто вошёл на кассу — из токена доступа (в нём id сотрудника и точки).
 * Подпись не проверяется: это не вопрос доверия, а адрес, по которому касса
 * хранит каталог и неотправленные чеки своей точки.
 */
export interface SessionClaims {
  id?: string;
  tenantId?: string;
  role?: string;
}

export function sessionClaims(): SessionClaims | null {
  try {
    const token = localStorage.getItem("pos-token");
    const payload = token?.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as SessionClaims;
  } catch {
    return null;
  }
}
