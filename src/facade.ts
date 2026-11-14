// Public facade (docs/API.md): createInstance / Instance / Bucket.
//
// A bucket is a local-first end-to-end-encrypted object KV. Local CRUD works
// with no account and no network; connect() is the single network/identity
// boundary. `namespace` scopes ALL local persistence (instance keys, auth
// context, sessions, objects, the internal index) and never reaches the
// wire; bucket `id` is the app-local authorization label, while sync uses
// the remote bucket id returned in the grant envelope. `~index` is local
// only; objects carry their app id in `~id` (docs/BUCKET-SPEC.md).

import { BucketClient, type BucketTransportLike, type ChangeSource } from "./bucket/client.ts";
import type { PayloadDoc } from "./bucket/format.ts";
import {
  canonicalizeFieldValue,
  createBucketBinaryValue,
  fieldValueToCanonicalJson,
  type BinaryInput,
  type BinaryOptions,
  type BucketBinaryValue,
} from "./bucket/binary.ts";
import {
  createIndexedDbStorageAdapter,
  createNamespacedMemoryStorageAdapter,
  type StorageAdapter,
} from "./bucket/store.ts";
import { BucketTransport, BucketTransportError, OfflineError } from "./bucket/transport.ts";
import { isValidBucketId } from "./auth/identifiers.ts";
import { ClientError, NotConnectedError } from "./errors.ts";
import { randomId } from "./internal/encoding.ts";
import { resolveAppId } from "./auth/identifiers.ts";
import type { InstanceKey } from "./auth/keys.ts";

import { createInstanceConnection } from "./remote/connection.ts";
import type { RemoteBucket } from "./remote/bucket.ts";

const INDEX_OBJECT_ID = "~index";
const ID_FIELD = "~id";
const DELETED_FIELD = "~deleted";
const RESERVED_PREFIX = "~";

export type CreateInstanceOptions = {
  namespace?: string;
  storage?: "indexeddb" | "memory";
  appId?: string;
};

export type BucketState = "disconnected" | "connecting" | "connected";

export type ListEntry = { id: string; updatedAt: string; deleted?: true };

export type ConnectOptions = {
  authBase?: string;
  autoSync?: boolean;
};

export type { BinaryInput, BinaryOptions, BucketBinaryValue };

export type Bucket = {
  readonly id: string;
  readonly state: BucketState;
  binary(input: BinaryInput | BucketBinaryValue, options?: BinaryOptions): BucketBinaryValue;
  /** @deprecated No-op kept for compatibility; operations initialize storage lazily. */
  ready(): Promise<void>;
  put(objectId: string, object: Record<string, unknown>): Promise<void>;
  get(objectId: string): Promise<Record<string, unknown> | null>;
  update(objectId: string, fields: Record<string, unknown>): Promise<void>;
  delete(objectId: string): Promise<void>;
  list(options?: { prefix?: string; includeDeleted?: boolean }): Promise<ListEntry[]>;
  resume(): Promise<BucketState>;
  connect(options?: ConnectOptions): Promise<BucketState>;
  disconnect(): Promise<void>;
  sync(): Promise<void>;
  setAutoSync(enabled: boolean): void;
  on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
  on(event: "change", handler: (objectId: string) => void): () => void;
  dispose(): void;
  // Internal test seam: binds a transport as if connect() succeeded, with
  // identity wire ids (blinding has its own unit tests). Not public API.
  __bindTestTransport(transport: BucketTransportLike): void;
};

export type Instance = {
  readonly namespace: string;
  readonly remote: { getBucket(): RemoteBucket };
  readonly state: BucketState;
  getBucket(): Bucket;
  getKey(): Promise<InstanceKey | null>;
  createKey(): Promise<InstanceKey>;
  importKey(key: InstanceKey): Promise<void>;
  removeKey(): Promise<void>;
  resume(options?: { autoSync?: boolean }): Promise<BucketState>;
  connect(options?: { autoSync?: boolean }): Promise<BucketState>;
  disconnect(): Promise<void>;
  on(event: "state", handler: (state: BucketState, error?: ClientError) => void): () => void;
  createBucket(options: { id: string }): Bucket;
};

export const instanceTestCleanup = new WeakMap<Instance, () => void>();

export function createInstance(appId: string): Instance;
export function createInstance(options?: CreateInstanceOptions): Instance;
export function createInstance(input: string | CreateInstanceOptions = {}, ...extra: unknown[]): Instance {
  if (typeof input === "string" && extra.length) throw new ClientError("INVALID_INPUT", "createInstance accepts an appId or an options object, without additional arguments");
  const options: CreateInstanceOptions = typeof input === "string" ? { appId: input } : input;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new ClientError("INVALID_INPUT", "Instance options are required");
  if (["authStorage", "dbName", "storeName"].some(key => key in options)) throw new ClientError("INVALID_INPUT", "Custom database configuration is not supported");
  if ("authUrl" in options) throw new ClientError("INVALID_INPUT", "Custom authorization URLs are not supported by the Instance API");
  const explicitAppId = options.appId === undefined ? undefined : resolveAppId(options.appId);
  let resolvedAppId = explicitAppId;
  const getAppId = () => resolvedAppId ??= resolveAppId();
  const namespace = normalizeNamespace(options.namespace === undefined ? explicitAppId : String(options.namespace).trim());
  const storageKind = options.storage || "indexeddb";

  const baseAdapter =
    storageKind === "memory"
      ? createNamespacedMemoryStorageAdapter(`myfield-sdk:${namespace}`)
      : createIndexedDbStorageAdapter({ dbName: `myfield-sdk:${namespace}` });
  const authAdapter = prefixedAdapter(baseAdapter, "auth:");

  const buckets = new Map<string, ReturnType<typeof createBucketFacade>>();
  const connections = new Map<string, ReturnType<typeof createInstanceConnection>>();
  const connectionDeps = { getAppId, data: baseAdapter, auth: authAdapter,
    hasActiveConnection: () => connection.active || [...connections.values()].some(value => value.active),
    persistent: storageKind !== "memory" };
  const connection = createInstanceConnection(connectionDeps);
  let disposed = false;

  function getLocalBucket(bucketId: string) {
    if (disposed) throw new ClientError("INVALID_STATE", "Instance runtime has stopped");
    const existing = buckets.get(bucketId);
    if (existing) return existing;
    let isDefault = false;
    try { isDefault = bucketId === getAppId(); } catch {}
    let resource = isDefault ? connection : connections.get(bucketId);
    if (!resource) {
      resource = createInstanceConnection({ ...connectionDeps, getBucketId: () => bucketId });
      connections.set(bucketId, resource);
    }
    const owned = resource;
    const runtime = createBucketFacade({ bucketId, dataAdapter: baseAdapter, connection: owned, onDispose: () => {
      if (buckets.get(bucketId) === runtime) buckets.delete(bucketId);
      if (owned !== connection && connections.get(bucketId) === owned) {
        connections.delete(bucketId);
        owned.dispose();
      }
    } });
    buckets.set(bucketId, runtime);
    return runtime;
  }

  function startLocal(prompt: boolean, args: unknown[]): Promise<BucketState> {
    try {
      if (args.length > 1) throw new ClientError("INVALID_INPUT", "Connection accepts one options object");
      const options = args[0];
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
        || Object.keys(options).some(key => key !== "autoSync")
        || ("autoSync" in options && options.autoSync !== undefined && typeof options.autoSync !== "boolean"))) {
        throw new ClientError("INVALID_INPUT", "Only autoSync is supported");
      }
      const runtime = getLocalBucket(getAppId());
      return runtime.connectInstance(prompt, (options as { autoSync?: boolean } | undefined)?.autoSync);
    } catch (error) { return Promise.reject(error); }
  }

  const instance: Instance = {
    namespace,
    remote: connection.remote,
    get state() { return connection.state; },
    getBucket: () => getLocalBucket(getAppId()).bucket,
    resume: (...args: unknown[]) => startLocal(false, args),
    on: connection.on,
    connect: (...args: unknown[]) => startLocal(true, args),
    getKey: connection.getKey,
    createKey: connection.createKey,
    importKey: connection.importKey,
    removeKey: connection.removeKey,
    disconnect: connection.disconnect,
    createBucket(bucketOptions) {
      const bucketId = String(bucketOptions?.id || "").trim();
      if (!bucketId) throw new Error("bucket id is required");
      if (!isValidBucketId(bucketId)) throw new Error("invalid bucketId");
      return getLocalBucket(bucketId).bucket;
    },
  };
  if (explicitAppId) getLocalBucket(explicitAppId);
  instanceTestCleanup.set(instance, () => {
    disposed = true;
    for (const runtime of buckets.values()) runtime.bucket.dispose();
    for (const resource of connections.values()) resource.dispose();
    connection.dispose();
  });
  return instance;
}

// ---------------------------------------------------------------------------

type BucketDeps = {
  bucketId: string;
  dataAdapter: StorageAdapter;
  connection: ReturnType<typeof createInstanceConnection>;
  onDispose?: () => void;
};

function createBucketFacade(deps: BucketDeps) {
  const { bucketId, dataAdapter, connection } = deps;
  const actorKey = `meta:actor`;

  let state: BucketState = connection.state;
  let client: BucketClient | null = null;
  let clientInit: Promise<BucketClient> | null = null;
  let liveTransport: BucketTransportLike | null = null;
  let liveWireId: ((appObjectId: string) => Promise<string>) | null = null;
  let autoSync = true;
  let syncIntervalMs: number | undefined;
  let disposed = false;

  let connectedAccess: ReturnType<typeof connection.getLocalAccess> | null = null;
  let activating: Promise<void> | null = null;
  let verifiedAccess: ReturnType<typeof connection.getLocalAccess> | null = null;
  let connecting: { operation: Promise<BucketState>; result: Promise<BucketState> } | null = null;
  let lastFailure: unknown = null;

  const listeners = { state: new Set<(s: BucketState, d?: string) => void>(), change: new Set<(id: string) => void>() };

  function emitState(next: BucketState, detail?: string): void {
    if (state !== next) {
      state = next;
      for (const handler of listeners.state) handler(next, detail);
    } else if (detail) {
      for (const handler of listeners.state) handler(next, detail);
    }
  }

  function emitChange(objectId: string): void {
    if (objectId.startsWith(RESERVED_PREFIX)) return;
    for (const handler of listeners.change) handler(objectId);
  }

  function ensureClient(): Promise<BucketClient> {
    if (clientInit) return clientInit;
    clientInit = (async () => {
      let actorId = await dataAdapter.get<string>(actorKey);
      if (typeof actorId !== "string" || !actorId) {
        actorId = randomId("actor");
        await dataAdapter.set(actorKey, actorId);
      }
      client = new BucketClient({
        transport: {
          pullHead(wireObjectId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.pullHead(wireObjectId);
          },
          pullPayload(wireObjectId, versionId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.pullPayload(wireObjectId, versionId);
          },
          push(wireObjectId, plaintext, expectedHeadVersionId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.push(wireObjectId, plaintext, expectedHeadVersionId);
          },
          listHeads() {
            if (!liveTransport?.listHeads) return Promise.reject(new OfflineError());
            return liveTransport.listHeads();
          },
        },
        storage: dataAdapter,
        autoSync: autoSync && Boolean(liveTransport),
        actorId,
        localOnlyObjectIds: [INDEX_OBJECT_ID],
        validateRemote: assertRemoteObjectId,
        wireObjectId: (appObjectId) => {
          if (!liveWireId) return Promise.reject(new OfflineError());
          return liveWireId(appObjectId);
        },
        storagePrefix: `data:${bucketId}`,
        onChange: onClientChange,
        onSyncError: (objectId, error) => {
          if (error instanceof OfflineError) return;
          // Retryable sync failures surface as state detail without a state
          // change; local data is never affected.
          const detail = `sync error${objectId ? ` (${objectId})` : ""}: ${formatError(error)}`;
          if (connection.state === "connected") connection.report(localError(error, detail));
          else emitState(state, detail);
        },
      });
      return client;
    })();
    return clientInit;
  }

  function assertRemoteObjectId(objectId: string, doc: PayloadDoc): void {
    if (objectId.startsWith(RESERVED_PREFIX) || doc.t !== "lww-map") return;
    const remoteId = doc.fields[ID_FIELD]?.v;
    if (remoteId !== undefined && remoteId !== objectId) throw new Error(`object id mismatch for ${objectId}`);
  }

  // Refresh the index before emitting, so a change handler's list() sees it.
  const pendingIndexRefreshes = new Set<Promise<void>>();
  function onClientChange(objectId: string, source: ChangeSource): void {
    if (objectId.startsWith(RESERVED_PREFIX)) return;
    if (source === "local") {
      emitChange(objectId);
      return;
    }
    const refresh = refreshIndexEntry(objectId)
      .catch((error) => emitState(state, `index update failed (${objectId}): ${formatError(error)}`))
      .finally(() => {
        pendingIndexRefreshes.delete(refresh);
        emitChange(objectId);
      });
    pendingIndexRefreshes.add(refresh);
  }

  async function refreshIndexEntry(objectId: string): Promise<void> {
    const c = await ensureClient();
    const raw = await c.getFields(objectId);
    const latest = await c.lastModified(objectId);
    await upsertIndexEntry(objectId, raw?.[DELETED_FIELD] === true, latest ?? Date.now());
  }

  // ---- local object API ---------------------------------------------------

  function assertObjectId(objectId: string): void {
    if (typeof objectId !== "string" || !objectId) throw new Error("objectId must be a non-empty string");
    if (objectId.startsWith(RESERVED_PREFIX)) throw new Error(`object ids starting with "${RESERVED_PREFIX}" are reserved`);
  }

  function assertFieldNames(fields: Record<string, unknown>): void {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be a plain object");
    for (const name of Object.keys(fields)) {
      if (name.startsWith(RESERVED_PREFIX)) throw new Error(`field names starting with "${RESERVED_PREFIX}" are reserved`);
    }
  }

  // `rev` keeps two writes in one millisecond distinct.
  let lastIndexRev = 0;
  async function upsertIndexEntry(objectId: string, deleted: boolean, updatedAtMs = Date.now()): Promise<void> {
    const c = await ensureClient();
    lastIndexRev = Math.max(lastIndexRev + 1, Date.now());
    await c.setFields(INDEX_OBJECT_ID, {
      [objectId]: {
        updatedAt: new Date(updatedAtMs).toISOString(),
        rev: lastIndexRev,
        ...(deleted ? { deleted: true } : {}),
      },
    });
  }

  function publicView(raw: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(raw).filter(([name]) => !name.startsWith(RESERVED_PREFIX)));
  }

  // Fields whose JSON value is unchanged keep their existing LWW
  // timestamp/source (API.md): re-stamping unchanged fields would let a
  // device that re-saves whole objects steamroll other devices' concurrent
  // field edits.
  async function dropUnchanged(updates: Record<string, unknown>, known: Record<string, unknown>): Promise<Record<string, unknown>> {
    const changed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(updates)) {
      if (value === undefined) {
        if (name in known) changed[name] = undefined;
        continue;
      }
      const canonicalValue = await canonicalizeFieldValue(value);
      if (name in known && JSON.stringify(fieldValueToCanonicalJson(await canonicalizeFieldValue(known[name]))) === JSON.stringify(fieldValueToCanonicalJson(canonicalValue))) continue;
      changed[name] = value;
    }
    return changed;
  }

  function withObjectId(updates: Record<string, unknown>, objectId: string, known: Record<string, unknown>): Record<string, unknown> {
    return known[ID_FIELD] === objectId ? updates : { ...updates, [ID_FIELD]: objectId };
  }

  async function put(objectId: string, object: Record<string, unknown>): Promise<void> {
    assertObjectId(objectId);
    assertFieldNames(object);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { ...object };
    for (const name of Object.keys(known)) {
      if (!(name in object) && name !== ID_FIELD) updates[name] = undefined; // deletes locally known omitted fields (incl. a live ~deleted marker)
    }
    const changed = await dropUnchanged(updates, known);
    if (Object.keys(changed).length === 0) return; // full no-op: do not advance LWW state or the index entry
    await c.setFields(objectId, withObjectId(changed, objectId, known));
    await upsertIndexEntry(objectId, false);
  }

  async function update(objectId: string, fields: Record<string, unknown>): Promise<void> {
    assertObjectId(objectId);
    assertFieldNames(fields);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { ...fields };
    if (DELETED_FIELD in known) updates[DELETED_FIELD] = undefined; // update recreates a deleted object
    const changed = await dropUnchanged(updates, known);
    if (Object.keys(changed).length === 0) return;
    await c.setFields(objectId, withObjectId(changed, objectId, known));
    await upsertIndexEntry(objectId, false);
  }

  async function getObject(objectId: string): Promise<Record<string, unknown> | null> {
    assertObjectId(objectId);
    const c = await ensureClient();
    const raw = await c.getFields(objectId);
    if (!raw) return null;
    if (raw[DELETED_FIELD]) return null;
    const view = publicView(raw);
    return Object.keys(view).length === 0 && !(await hasIndexEntry(objectId)) ? null : view;
  }

  async function hasIndexEntry(objectId: string): Promise<boolean> {
    const c = await ensureClient();
    const index = (await c.getFields(INDEX_OBJECT_ID)) || {};
    return objectId in index;
  }

  async function deleteObject(objectId: string): Promise<void> {
    assertObjectId(objectId);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { [DELETED_FIELD]: true };
    for (const name of Object.keys(known)) {
      if (!name.startsWith(RESERVED_PREFIX)) updates[name] = undefined;
    }
    await c.setFields(objectId, withObjectId(updates, objectId, known));
    await upsertIndexEntry(objectId, true);
  }

  async function list(options?: { prefix?: string; includeDeleted?: boolean }): Promise<ListEntry[]> {
    const c = await ensureClient();
    const index = (await c.getFields(INDEX_OBJECT_ID)) || {};
    const rows: ListEntry[] = [];
    for (const [objectId, value] of Object.entries(index)) {
      if (objectId.startsWith(RESERVED_PREFIX)) continue;
      if (options?.prefix && !objectId.startsWith(options.prefix)) continue;
      const entry = value as { updatedAt?: unknown; deleted?: unknown } | null;
      if (!entry || typeof entry.updatedAt !== "string") continue;
      const deleted = entry.deleted === true;
      if (deleted && !options?.includeDeleted) continue;
      rows.push({ id: objectId, updatedAt: entry.updatedAt, ...(deleted ? { deleted: true as const } : {}) });
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return rows;
  }

  // ---- sync ---------------------------------------------------------------

  async function sync(): Promise<void> {
    if (!liveTransport) throw new NotConnectedError();
    await runSyncPass();
  }

  async function runSyncPass(): Promise<void> {
    const c = await ensureClient();
    const wireId = liveWireId;
    if (!wireId) throw new OfflineError();
    // 0.9.0 compatibility: skip the remote ~index, but use it to resolve objects without ~id.
    let legacyIndex: Record<string, unknown> | null | undefined;
    await c.syncPass({
      skipWireIds: [await wireId(INDEX_OBJECT_ID)],
      resolveUnknown: async (wireObjectId, versionId) => {
        const doc = await c.pullDoc(wireObjectId, versionId);
        if (!doc || doc.t !== "lww-map") return null;
        const id = doc.fields[ID_FIELD]?.v;
        if (typeof id === "string") return id;
        if (legacyIndex === undefined) {
          const legacy = await c.pullRemoteDoc(INDEX_OBJECT_ID);
          legacyIndex = legacy?.t === "lww-map" ? legacy.fields : null;
        }
        for (const candidate of Object.keys(legacyIndex || {})) {
          if (!candidate.startsWith(RESERVED_PREFIX) && (await wireId(candidate)) === wireObjectId) return candidate;
        }
        return null;
      },
    });
    await writeMissingObjectIds(c);
    await Promise.all(pendingIndexRefreshes);
  }

  // 0.9.0 compatibility: add ~id to objects written without it.
  async function writeMissingObjectIds(c: BucketClient): Promise<void> {
    const upgraded: string[] = [];
    for (const id of await c.knownObjectIds()) {
      if (id.startsWith(RESERVED_PREFIX)) continue;
      const raw = await c.getFields(id);
      if (!raw || raw[ID_FIELD] === id) continue;
      await c.setFields(id, { [ID_FIELD]: id });
      upgraded.push(id);
    }
    for (const id of upgraded) await c.flush(id);
  }

  function startAutoSync(): void {
    if (!autoSync || !client) return;
    client.start({ run: runSyncPass, ...(syncIntervalMs !== undefined ? { intervalMs: syncIntervalMs } : {}) });
  }

  function bindTransport() {
    const current = connection.getLocalAccess();
    if (current === connectedAccess) return current;
    connectedAccess = current;
    liveTransport = new BucketTransport({ apiBase: current.access.resourceApiUrl!,
      mfid: current.access.mfid, keys: current.access.keys,
      sessionProvider: current.sessionProvider, fetch: current.fetch });
    liveWireId = current.access.keys.wireObjectId;
    return current;
  }

  function stopLocal() {
    liveTransport = null;
    liveWireId = null;
    connectedAccess = null;
    verifiedAccess = null;
    activating = null;
    client?.stop();
  }

  let connectionState = connection.state;
  const stopState = connection.on("state", (next, error) => {
    if (disposed) return;
    const entered = next === "connected" && connectionState !== "connected";
    connectionState = next;
    if (next === "disconnected" && error) lastFailure = error;
    if (next === "connected") bindTransport(); else stopLocal();
    emitState(next, error ? formatError(error) : undefined);
    // Error reports re-emit "connected"; only a new connection starts sync.
    if (entered) void reconcile().catch(() => {});
  });
  if (state === "connected") bindTransport();

  function activate(): Promise<void> {
    const current = bindTransport();
    if (verifiedAccess === current) {
      startAutoSync();
      return Promise.resolve();
    }
    if (activating) return activating;
    const operation = (async () => {
      const transport = liveTransport!;
      await ensureClient();
      current.signal.throwIfAborted();
      await transport.pullHead(await current.access.keys.wireObjectId(INDEX_OBJECT_ID));
      current.signal.throwIfAborted();
      if (disposed) return;
      verifiedAccess = current;
      startAutoSync();
    })().catch(async error => {
      current.signal.throwIfAborted();
      if (disposed) return;
      const failure = localError(error);
      if (failure.retryable) {
        // Keep shared access; automatic sync retries and reports later failures.
        connection.report(failure);
        startAutoSync();
        return;
      }
      await connection.fail(failure, current.signal);
      throw failure;
    }).finally(() => { if (activating === operation) activating = null; });
    activating = operation;
    return operation;
  }

  // Automatic sync runs exactly while the connection is up and autoSync is on.
  function reconcile(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!autoSync || !liveTransport) { client?.stop(); return Promise.resolve(); }
    return activate();
  }

  function connectInstance(prompt: boolean, enabled?: boolean): Promise<BucketState> {
    if (enabled !== undefined) bucket.setAutoSync(enabled);
    const operation = prompt ? connection.connect() : connection.resume();
    if (connecting?.operation === operation) return connecting.result;
    const done = operation.then(async next => {
      if (next === "connected") await reconcile();
      return next;
    }).finally(() => { if (connecting?.result === done) connecting = null; });
    connecting = { operation, result: done };
    return done;
  }

  // 0.9.1 semantics: invalid calls reject; authorization-flow failures resolve
  // "disconnected" after the state event carries the error.
  async function connectLegacy(prompt: boolean, authBase?: string): Promise<BucketState> {
    if (disposed) throw new Error("disposed");
    await ensureClient();
    if (typeof window === "undefined") {
      if (!prompt) return state;
      throw new ClientError("INVALID_STATE", "Connecting requires a browser");
    }
    let next: BucketState;
    try {
      next = await (prompt ? connection.connectLegacy(authBase) : connection.resumeLegacy());
    } catch (error) {
      if (error === lastFailure || isAbortError(error)) return "disconnected";
      throw error;
    }
    if (next !== "connected") return next;
    try { await reconcile(); } catch { return "disconnected"; }
    return next;
  }

  // ---- public object ------------------------------------------------------

  const bucket: Bucket = {
    id: bucketId,
    get state() {
      return state;
    },
    binary(input, options) {
      return createBucketBinaryValue(input, options);
    },
    async ready() {},
    put,
    get: getObject,
    update,
    delete: deleteObject,
    list,
    resume: () => connectLegacy(false),
    connect(options) {
      if (options?.autoSync !== undefined) this.setAutoSync(options.autoSync);
      return connectLegacy(true, options?.authBase || undefined);
    },
    disconnect: () => connection.disconnect(),
    async sync() {
      await sync();
    },
    setAutoSync(enabled) {
      autoSync = enabled;
      void reconcile().catch(() => {});
    },
    on(event: "state" | "change", handler: (...args: never[]) => void): () => void {
      const set = listeners[event] as Set<(...args: unknown[]) => void>;
      set.add(handler as (...args: unknown[]) => void);
      return () => set.delete(handler as (...args: unknown[]) => void);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      client?.dispose();
      stopState();
      stopLocal();
      deps.onDispose?.();
    },
    __bindTestTransport(transport) {
      liveTransport = transport;
      liveWireId = async (appObjectId) => appObjectId;
      emitState("connected");
    },
  };
  return { bucket, connectInstance };
}

function normalizeNamespace(value: string | undefined): string {
  const namespace = value === undefined ? "default" : value;
  if (typeof namespace !== "string" || namespace.length > 63 || !namespace.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ClientError("INVALID_INPUT", "namespace must be a lowercase domain-form name of 1–63 characters");
  }
  return namespace;
}

function prefixedAdapter(adapter: StorageAdapter, prefix: string): StorageAdapter {
  return {
    ...(adapter.removePrefix ? { removePrefix: (keyPrefix: string) => adapter.removePrefix!(`${prefix}${keyPrefix}`) } : {}),
    ...(adapter.insertIfEmpty ? { insertIfEmpty: (keyPrefix: string, entries: { key: string; value: unknown }[]) =>
      adapter.insertIfEmpty!(`${prefix}${keyPrefix}`, entries.map(entry => ({ ...entry, key: `${prefix}${entry.key}` }))) } : {}),
    get: (key) => adapter.get(`${prefix}${key}`),
    set: (key, value) => adapter.set(`${prefix}${key}`, value),
    remove: (key) => adapter.remove(`${prefix}${key}`),
    keys: async (keyPrefix) => (await adapter.keys(`${prefix}${keyPrefix}`)).map((key) => key.slice(prefix.length)),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localError(error: unknown, message = formatError(error)): ClientError {
  if (error instanceof ClientError) {
    if (message === error.message) return error;
    return new ClientError(error.code, message, { cause: error, retryable: error.retryable, status: error.status,
      requestId: error.requestId, retryAfterMs: error.retryAfterMs, maxBytes: error.maxBytes });
  }
  const retryable = error instanceof BucketTransportError ? error.retryable : error instanceof TypeError;
  return new ClientError(retryable ? "NETWORK_ERROR" : "SYNC_FAILED", message, {
    cause: error, retryable, status: error instanceof BucketTransportError ? error.status : undefined,
  });
}
