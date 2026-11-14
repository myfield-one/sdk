import type { StorageAdapter } from "../bucket/store.ts";
import { ClientError } from "../errors.ts";
import { createInstanceKey, type AuthInstance } from "./keys.ts";
import { isPublicP256EcJwk, isValidInstanceId } from "./identifiers.ts";

type StoredInstance = AuthInstance & { updatedAt: string };

export function authRecordKeys(appId: string) {
  const prefix = `instance:${encodeURIComponent(appId)}:`;
  const segment = encodeURIComponent;
  return {
    prefix,
    active: `${prefix}active-instance:current`,
    keyPrefix: `${prefix}instance-key:`,
    key: (id: string) => `${prefix}instance-key:${segment(id)}`,
    pending: (resource: string, id: string) => `${prefix}pending-auth:${segment(resource)}:${segment(id)}`,
    callback: (id: string) => `${prefix}callback-pointer:${segment(id)}`,
    context: (resource: string, id: string) => `${prefix}context:${segment(resource)}:${segment(id)}`,
    session: (resource: string, id: string) => `${prefix}session:${segment(resource)}:${segment(id)}`,
    endpoints: (bucket: string) => `meta:${bucket}:endpoints`,
  };
}

export function createInstanceKeyStore(storage: StorageAdapter, appId: string) {
  const keys = authRecordKeys(appId);
  async function read(id: string): Promise<StoredInstance | null> {
    const value = await storage.get<StoredInstance>(keys.key(id));
    if (!value) return null;
    if (value.v !== 1 || value.instanceId !== id || !isValidInstanceId(id)
      || !isPublicP256EcJwk(value.signingPublicJwk) || !isPublicP256EcJwk(value.wrappingPublicJwk)
      || !(value.signingPrivateKey instanceof CryptoKey) || !(value.wrappingPrivateKey instanceof CryptoKey)) {
      throw new ClientError("INVALID_INSTANCE_KEY", "Stored instance key is invalid");
    }
    return value;
  }
  async function active(): Promise<StoredInstance | null> {
    let pointer = await storage.get<{ v: number; instanceId: string }>(keys.active);
    if (pointer === null) {
      if (!(await storage.keys(keys.keyPrefix)).length) return null;
      pointer = await storage.get<{ v: number; instanceId: string }>(keys.active);
      if (pointer === null) throw new ClientError("INVALID_INSTANCE_KEY", "Instance key has no active pointer");
    }
    if (pointer.v !== 1 || !isValidInstanceId(pointer.instanceId)) throw new ClientError("INVALID_INSTANCE_KEY", "Stored instance pointer is invalid");
    const value = await read(pointer.instanceId);
    if (!value) throw new ClientError("INVALID_INSTANCE_KEY", "Stored instance key is missing");
    return value;
  }
  async function insert(instance: AuthInstance): Promise<boolean> {
    if (await storage.get(keys.active) !== null) return false;
    const now = new Date().toISOString();
    const entries = [{ key: keys.key(instance.instanceId), value: { ...instance, updatedAt: now } },
      { key: keys.active, value: { v: 1, instanceId: instance.instanceId, updatedAt: now } }];
    if (storage.insertIfEmpty) return storage.insertIfEmpty(keys.keyPrefix, entries);
    if ((await storage.keys(keys.keyPrefix)).length) return false;
    const written: string[] = [];
    try {
      for (const entry of entries) { await storage.set(entry.key, entry.value); written.push(entry.key); }
    } catch (error) { for (const key of written) await storage.remove(key); throw error; }
    return true;
  }
  let ensuring: Promise<StoredInstance> | undefined;
  async function save(instance: AuthInstance) {
    if (!await insert(instance)) throw new ClientError("KEY_EXISTS", "An instance key already exists for this appId");
  }
  async function create(beforeWrite: () => void = () => {}) {
    const instance = await createInstanceKey();
    beforeWrite();
    await save(instance);
    return instance;
  }
  return {
    keys, read, active,
    import: save, create,
    async remove() {
      if (storage.removePrefix) return storage.removePrefix(keys.prefix);
      for (const key of await storage.keys(keys.prefix)) await storage.remove(key);
    },
    ensure(): Promise<StoredInstance> {
      return ensuring ??= (async () => {
        const saved = await active();
        if (saved) return saved;
        try { await create(); }
        catch (error) { if (!(error instanceof ClientError) || error.code !== "KEY_EXISTS") throw error; }
        const value = await active();
        if (!value) throw new ClientError("INVALID_INSTANCE_KEY", "Instance key was not saved");
        return value;
      })().finally(() => { ensuring = undefined; });
    },
  };
}
