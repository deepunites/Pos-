/**
 * Хранилище офлайн-режима на самом планшете: каталог и неотправленные чеки.
 *
 * IndexedDB, а не localStorage: каталог магазина — тысячи товаров, а
 * localStorage держит несколько мегабайт и пишет синхронно, подвешивая экран.
 * Где IndexedDB нет (тесты, приватный режим старых браузеров) — память
 * страницы: касса работает, но офлайн-чеки переживут только эту вкладку.
 */

const DB_NAME = "qwik-offline";
const STORE = "kv";

const memory = new Map<string, unknown>();
let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) return resolve(undefined);
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return memory.get(key) as T | undefined;
  return run<T>("readonly", (store) => store.get(key));
}

export async function dbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    memory.set(key, value);
    return;
  }
  await run("readwrite", (store) => store.put(value, key));
}

export async function dbDelete(key: string): Promise<void> {
  const db = await open();
  if (!db) {
    memory.delete(key);
    return;
  }
  await run("readwrite", (store) => store.delete(key));
}

/**
 * Попросить браузер не вычищать наши данные при нехватке места: в очереди
 * лежат чеки, за которые уже взяты деньги. Браузер может отказать — тогда
 * данные всё равно хранятся, просто без гарантии.
 */
export function askPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    // нет API — ничего не поделать
  }
}

/** Для тестов: забыть всё. */
export function resetOfflineDb(): void {
  memory.clear();
}
