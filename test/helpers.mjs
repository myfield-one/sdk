// Shared test helpers: an in-memory CAS relay standing in for the worker's
// open bucket surface, and a plain memory storage adapter.

export function createMockRelay() {
  const objects = new Map(); // wireId -> { versionId, plaintext }
  return {
    objects,
    evict(wireId) {
      objects.delete(wireId);
    },
    transport() {
      return {
        async pullHead(wireId) {
          const entry = objects.get(wireId);
          if (!entry) return { found: false };
          return { found: true, versionId: entry.versionId };
        },
        async pullPayload(wireId, versionId) {
          const entry = objects.get(wireId);
          if (!entry || entry.versionId !== versionId) return { found: false };
          return { found: true, plaintext: entry.plaintext.slice() };
        },
        async push(wireId, plaintext, expectedHeadVersionId) {
          const entry = objects.get(wireId);
          const currentVersion = entry?.versionId ?? null;
          if (currentVersion !== expectedHeadVersionId) {
            return { ok: false, conflict: true, remoteVersionId: currentVersion };
          }
          const versionId = crypto.randomUUID();
          objects.set(wireId, { versionId, plaintext: plaintext.slice() });
          return { ok: true, versionId };
        },
      };
    },
  };
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return Array.from(map.keys()).filter((key) => key.startsWith(prefix));
    },
  };
}

// Reference-holding storage for values that may not be structured-cloneable
// in every runtime (CryptoKey in some Node versions).
export function createReferenceStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return Array.from(map.keys()).filter((key) => key.startsWith(prefix));
    },
  };
}
