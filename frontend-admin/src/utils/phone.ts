// Телефоны клиентов — узбекские: +998 и девять цифр (код оператора и номер).
// Касса ставит +998 сама, кассир набирает только «90 123-45-67». Раньше поле
// было свободным, и в чек попадали «+9989», «90-123», «8 90 …».

export const UZ_PREFIX = "+998";
const LOCAL_LENGTH = 9;

/** Что набрал или вставил кассир → до девяти цифр после +998. */
export function localDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  // Номер вставили целиком («+998 90 123 45 67») или набрали +998 по привычке:
  // как только цифр больше девяти, код страны лишний.
  if (digits.length > LOCAL_LENGTH && digits.startsWith("998")) digits = digits.slice(3);
  return digits.slice(0, LOCAL_LENGTH);
}

/** «901234567» → «90 123-45-67»; по мере набора — «90 1», «90 123-4». */
export function formatLocal(digits: string): string {
  const d = digits.slice(0, LOCAL_LENGTH);
  let out = d.slice(0, 2);
  if (d.length > 2) out += " " + d.slice(2, 5);
  if (d.length > 5) out += "-" + d.slice(5, 7);
  if (d.length > 7) out += "-" + d.slice(7, 9);
  return out;
}

/** Девять цифр → «+998901234567»; ничего не набрано → undefined; номер не дописан → null. */
export function fullPhone(digits: string): string | undefined | null {
  if (!digits) return undefined;
  return digits.length === LOCAL_LENGTH ? UZ_PREFIX + digits : null;
}
