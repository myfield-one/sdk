// Minimal local persistence boundary. Local is the source of truth; the
// cloud is a sync relay, not a backup. Apps may swap in their own adapter
// (RxDB, SQLite, ...) — the SDK only needs get/set/remove/keys.

export type StorageAdapter = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  removePrefix?(prefix: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  insertIfEmpty?(prefix: string, entries: { key: string; value: unknown }[]): Promise<boolean>;
};

// Per-process registry so memory-backed instances behave like persistent
// storage within one process: re-creating an instance with the same
// namespace sees the same data (test seam for namespace semantics).
const memoryNamespaceRegistry = new Map<string, Map<string, unknown>>();

export function createNamespacedMemoryStorageAdapter(namespace: string): StorageAdapter {
  let map = memoryNamespaceRegistry.get(namespace);
  if (!map) {
    map = new Map<string, unknown>();
    memoryNamespaceRegistry.set(namespace, map);
  }
  return memoryAdapterOver(map);
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return memoryAdapterOver(new Map<string, unknown>());
}

function memoryAdapterOver(map: Map<string, unknown>): StorageAdapter {
  return {
    async removePrefix(prefix) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    },
    async insertIfEmpty(prefix, entries) {
      if ([...map.keys()].some(key => key.startsWith(prefix))) return false;
      const cloned = entries.map(({ key, value }) => ({ key, value: structuredClone(value) }));
      for (const { key, value } of cloned) map.set(key, value);
      return true;
    },
    async get<T>(key: string): Promise<T | null> {
      return map.has(key) ? (structuredClone(map.get(key)) as T) : null;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
    async keys(prefix: string): Promise<string[]> {
      return Array.from(map.keys()).filter((key) => key.startsWith(prefix));
    },
  };
}

const IDB_BLOCKED_TIMEOUT_MS = 15_000;
const IDB_SCHEMA_UPGRADE_MAX_ATTEMPTS = 5;

export function createIndexedDbStorageAdapter(options: { dbName: string; storeName?: string }): StorageAdapter {
  const dbName = options.dbName;
  const storeName = options.storeName || "kv";
  return {
    removePrefix: prefix => withIdb(dbName, storeName, db => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Atomic removal failed"));
    })),
    insertIfEmpty: (prefix, entries) => withIdb(dbName, storeName, db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite"), store = tx.objectStore(storeName);
      let inserted = false;
      const count = store.count(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      count.onsuccess = () => {
        if (count.result) return;
        try {
          for (const { key, value } of entries) store.put(value, key);
          inserted = true;
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(inserted);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Atomic write failed"));
    })),
    get: <T>(key: string) =>
      withIdb<T | null>(dbName, storeName, (db) =>
        requestPromise<T | null>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).get(key);
          let result: T | null = null;
          req.onsuccess = () => {
            result = (req.result as T) ?? null;
          };
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("idb get aborted"));
        })
      ),
    set: (key, value) =>
      withIdb<void>(dbName, storeName, (db) =>
        requestPromise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const req = tx.objectStore(storeName).put(value, key);
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("idb set aborted"));
        })
      ),
    remove: (key) =>
      withIdb<void>(dbName, storeName, (db) =>
        requestPromise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const req = tx.objectStore(storeName).delete(key);
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("idb delete aborted"));
        })
      ),
    keys: (prefix) =>
      withIdb<string[]>(dbName, storeName, (db) =>
        requestPromise<string[]>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
          const req = tx.objectStore(storeName).getAllKeys(range);
          let result: string[] = [];
          req.onsuccess = () => {
            result = (req.result as IDBValidKey[]).filter((key): key is string => typeof key === "string");
          };
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("idb keys aborted"));
        })
      ),
  };
}

function requestPromise<T>(executor: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
  return new Promise<T>(executor);
}

async function withIdb<T>(dbName: string, storeName: string, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < IDB_SCHEMA_UPGRADE_MAX_ATTEMPTS; attempt += 1) {
    let db: IDBDatabase | null = null;
    try {
      db = await openIdb(dbName, storeName);
      return await fn(db);
    } catch (error) {
      lastError = error;
    } finally {
      db?.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("idb operation failed");
}

function openIdb(dbName: string, storeName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("indexedDB unavailable");
  const open = (version?: number) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = version == null ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (db: IDBDatabase) => {
        if (settled) return;
        settled = true;
        if (blockedTimer) clearTimeout(blockedTimer);
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        blockedTimer = setTimeout(() => reject(new Error("idb open blocked")), IDB_BLOCKED_TIMEOUT_MS);
      };
    });
  return open().then(async (db) => {
    if (db.objectStoreNames.contains(storeName)) return db;
    const nextVersion = db.version + 1;
    db.close();
    return open(nextVersion);
  });
}
