/**
 * IndexedDB persistence (extension origin; survives browser restarts; never synced).
 */
const DB_NAME = 'repomind';
const DB_VERSION = 1;
export const STORES = ['projects', 'snapshots', 'indexes', 'memory', 'tasks', 'runs', 'activity', 'kv'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error ?? req.error);
        t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
      })
  );
}

export const db = {
  get: <T>(store: StoreName, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  put: <T>(store: StoreName, key: string, value: T) => tx(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined),
  del: (store: StoreName, key: string) => tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined),
  all: <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  keys: (store: StoreName) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store: StoreName) => tx(store, 'readwrite', (s) => s.clear()).then(() => undefined),
  async wipe(): Promise<void> {
    for (const s of STORES) await db.clear(s);
  }
};
