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
import { BucketTransport, OfflineError } from "./bucket/transport.ts";
import { createInstanceAuthClient, isValidBucketId, type AuthCallbackResult, type InstanceAuthClient } from "./auth/instance.ts";
import { ClientError, NotConnectedError } from "./errors.ts";
import { randomId } from "./internal/encoding.ts";
import { resolveAppId } from "./auth/identifiers.ts";
import type { InstanceKey } from "./auth/keys.ts";

import { createInstanceConnection } from "./remote/connection.ts";
import type { RemoteBucket } from "./remote/bucket.ts";

const DEFAULT_AUTH_BASE = "https://myfield.one/auth/";
const DEFAULT_API_BASE = "https://api.myfield.one";
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
  getKey(): Promise<InstanceKey | null>;
  createKey(): Promise<InstanceKey>;
  importKey(key: InstanceKey): Promise<void>;
  removeKey(): Promise<void>;
  resume(): Promise<BucketState>;
  connect(): Promise<BucketState>;
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

  // One handle per bucket id: separate facades over the same storage would
  // split event listeners and duplicate clients/clocks/debounce timers.
  const buckets = new Map<string, Bucket>();
  const connection = createInstanceConnection({ getAppId, data: baseAdapter, auth: authAdapter,
    hasLegacyBucket: () => { try { return buckets.has(getAppId()); } catch { return false; } },
    hasActiveLocalConnection: () => [...buckets.values()].some(bucket => bucket.state !== "disconnected"),
    persistent: storageKind !== "memory" });
  let disposed = false;

  const instance: Instance = {
    namespace,
    remote: connection.remote,
    get state() { return connection.state; },
    resume: connection.resume,
    on: connection.on,
    connect: connection.connect,
    getKey: connection.getKey,
    createKey: connection.createKey,
    importKey: connection.importKey,
    removeKey: connection.removeKey,
    disconnect: connection.disconnect,
    createBucket(bucketOptions) {
      if (disposed) throw new ClientError("DISPOSED", "Instance has been disposed");
      const bucketId = String(bucketOptions?.id || "").trim();
      if (!bucketId) throw new Error("bucket id is required");
      if (!isValidBucketId(bucketId)) throw new Error("invalid bucketId");
      const existing = buckets.get(bucketId);
      if (existing) return existing;
      const bucket = createBucketFacade({ namespace, bucketId, dataAdapter: baseAdapter, authAdapter, getAppId });
      buckets.set(bucketId, bucket);
      try { if (bucketId === getAppId()) connection.block(); } catch {}
      return bucket;
    },
  };
  instanceTestCleanup.set(instance, () => {
    disposed = true;
    for (const bucket of buckets.values()) bucket.dispose();
    connection.dispose();
  });
  return instance;
}

// ---------------------------------------------------------------------------

type BucketDeps = {
  namespace: string;
  bucketId: string;
  dataAdapter: StorageAdapter;
  authAdapter: StorageAdapter;
  getAppId(): string;
};

function createBucketFacade(deps: BucketDeps): Bucket {
  const { bucketId, dataAdapter, authAdapter } = deps;
  const endpointsKey = `meta:${bucketId}:endpoints`;
  const actorKey = `meta:actor`;

  let state: BucketState = "disconnected";
  let client: BucketClient | null = null;
  let clientInit: Promise<BucketClient> | null = null;
  let liveTransport: BucketTransportLike | null = null;
  let liveWireId: ((appObjectId: string) => Promise<string>) | null = null;
  let autoSync = true;
  let syncIntervalMs: number | undefined;
  let disposed = false;

  // Browser auth machinery (lazy; never touched by the test seam path).
  let authClient: InstanceAuthClient | null = null;
  let popupAuthClient: InstanceAuthClient | null = null;
  let authPageOrigin = "";
  let authPopupWindow: Window | null = null;
  let authPopupPollTimer: ReturnType<typeof setInterval> | null = null;
  let pendingConnect: { resolve: (state: BucketState) => void } | null = null;
  let pendingConnectDone: Promise<BucketState> | null = null;
  let popupMessageListener: ((event: MessageEvent<unknown>) => void) | null = null;

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

  function settlePendingConnect(): void {
    if (!pendingConnect) return;
    const settle = pendingConnect;
    pendingConnect = null;
    settle.resolve(state);
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
          emitState(state, `sync error${objectId ? ` (${objectId})` : ""}: ${formatError(error)}`);
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

  // ---- connection (browser) ----------------------------------------------

  async function readStoredEndpoints(): Promise<{ authBase: string; apiBase: string }> {
    const stored = await dataAdapter.get<{ authBase?: string; apiBase?: string }>(endpointsKey);
    const authBase = stored?.authBase || DEFAULT_AUTH_BASE;
    return {
      authBase,
      apiBase: stored?.apiBase || apiBaseForAuthBase(authBase),
    };
  }

  async function ensureAuthClients(endpoints: { authBase: string; apiBase: string }): Promise<InstanceAuthClient> {
    if (authClient) return authClient;
    if (typeof window === "undefined") throw new Error("connect()/resume() require a browser environment");
    const origin = window.location.origin;
    const authPageUrl = normalizeAuthBase(endpoints.authBase);
    authPageOrigin = new URL(authPageUrl, window.location.href).origin;
    const baseOptions = {
      appId: deps.getAppId(),
      apiBase: endpoints.apiBase,
      redirectUri: origin + window.location.pathname,
      origin,
      storage: authAdapter,
    };
    authClient = createInstanceAuthClient({
      ...baseOptions,
      authPageUrl: addCallbackTransport(authPageUrl, "same-tab"),
    });
    popupAuthClient = createInstanceAuthClient({
      ...baseOptions,
      authPageUrl: addCallbackTransport(authPageUrl, "popup"),
      openAuthUrl: (url) => openAuthPopupUrl(url),
    });
    popupMessageListener = (event: MessageEvent<unknown>) => void onPopupMessage(event);
    window.addEventListener("message", popupMessageListener);
    return authClient;
  }

  function clearPopupMonitor(): void {
    if (authPopupPollTimer != null) {
      clearInterval(authPopupPollTimer);
      authPopupPollTimer = null;
    }
  }

  function tryOpenPopupShell(): boolean {
    clearPopupMonitor();
    authPopupWindow?.close();
    const width = 520;
    const height = 720;
    const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
    authPopupWindow = window.open(
      "about:blank",
      "myfield-sdk-auth",
      `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
    if (!authPopupWindow || authPopupWindow.closed) {
      authPopupWindow = null;
      return false;
    }
    try {
      authPopupWindow.document.title = "Opening Myfield...";
      authPopupWindow.document.body.textContent = "Opening Myfield authorization...";
    } catch {
      // Same-origin about:blank in normal browsers; ignore if blocked.
    }
    authPopupWindow.focus();
    authPopupPollTimer = setInterval(() => {
      if (!authPopupWindow?.closed) return;
      clearPopupMonitor();
      if (state === "connecting") {
        emitState("disconnected", "authorization window closed");
        settlePendingConnect();
      }
    }, 500);
    return true;
  }

  function openAuthPopupUrl(url: string): void {
    if (!authPopupWindow || authPopupWindow.closed) {
      if (!tryOpenPopupShell()) throw new Error("authorization popup was blocked");
    }
    try {
      authPopupWindow!.location.href = url;
      authPopupWindow!.focus();
    } catch {
      authPopupWindow = window.open(url, "myfield-sdk-auth");
      if (!authPopupWindow) throw new Error("authorization popup was blocked");
    }
  }

  async function onPopupMessage(event: MessageEvent<unknown>): Promise<void> {
    if (event.origin !== authPageOrigin) return;
    const message = event.data as { type?: unknown; callbackUrl?: unknown } | null;
    if (!message || message.type !== "myfield.auth.callback" || typeof message.callbackUrl !== "string") return;
    clearPopupMonitor();
    authPopupWindow?.close();
    authPopupWindow = null;
    await handleCallbackUrl(message.callbackUrl);
  }

  async function handleCallbackUrl(callbackUrl: string): Promise<AuthCallbackResult | null> {
    try {
      const auth = await ensureAuthClients(await readStoredEndpoints());
      const callback = await auth.handleCallback(callbackUrl);
      if (!callback) return null;
      if (callback.result === "approved") {
        await establish({ forceRefresh: true });
      } else {
        emitState("disconnected", callback.errorDescription || callback.error || callback.result);
        settlePendingConnect();
      }
      return callback;
    } catch (error) {
      emitState("disconnected", formatError(error));
      settlePendingConnect();
      return null;
    }
  }

  async function establish(sessionOptions: { forceRefresh?: boolean } = {}): Promise<void> {
    emitState("connecting");
    try {
      const endpoints = await readStoredEndpoints();
      const auth = await ensureAuthClients(endpoints);
      const c = await ensureClient();
      await auth.getSession(bucketId, sessionOptions);
      const access = await auth.getBucketAccess(bucketId);
      if (!access.resourceApiUrl) throw new Error("auth callback missing resourceApiUrl; reconnect through the current Myfield auth page");
      const transport = new BucketTransport({
        apiBase: access.resourceApiUrl,
        mfid: access.mfid,
        keys: access.keys,
        sessionProvider: {
          getSession: (sessionOpts) => auth.getSession(bucketId, sessionOpts),
          onUnauthorized: () => {
            // Grant revoked: drop back to local-first; reconnecting needs a
            // user gesture through connect() again.
            liveTransport = null;
            liveWireId = null;
            c.stop();
            emitState("disconnected", "unauthorized");
          },
        },
      });
      await verifyConnectedTransport(transport, access.keys.wireObjectId);
      liveTransport = transport;
      liveWireId = access.keys.wireObjectId;
      startAutoSync();
      emitState("connected");
    } catch (error) {
      client?.stop();
      emitState("disconnected", formatError(error));
    } finally {
      settlePendingConnect();
    }
  }

  async function verifyConnectedTransport(transport: BucketTransport, wireObjectId: (appObjectId: string) => Promise<string>): Promise<void> {
    await transport.pullHead(await wireObjectId(INDEX_OBJECT_ID));
  }

  async function handleStartupCallback(): Promise<boolean> {
    const href = window.location.href;
    if (!href.includes("mf_auth_result") && !new URL(href).searchParams.get("mf_request_id")) return false;
    const callback = await handleCallbackUrl(href);
    if (callback) stripCallbackFromUrl();
    return !!callback;
  }

  function stripCallbackFromUrl(): void {
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      for (const param of ["state", "error", "error_description", "error_uri", "mf_request_id", "mf_result"]) url.searchParams.delete(param);
      window.history.replaceState(null, "", url.toString());
    } catch {
      // Cosmetic only.
    }
  }

  // ---- public object ------------------------------------------------------

  return {
    id: bucketId,
    get state() {
      return state;
    },
    binary(input, options) {
      return createBucketBinaryValue(input, options);
    },
    async ready() {
      await ensureClient();
    },
    put,
    get: getObject,
    update,
    delete: deleteObject,
    list,
    async resume() {
      if (disposed) throw new Error("disposed");
      await ensureClient();
      if (typeof window === "undefined") return state;
      if (state !== "disconnected") return state;
      const auth = await ensureAuthClients(await readStoredEndpoints());
      if (await handleStartupCallback()) return state;
      const context = await auth.getContext(bucketId);
      if (context) await establish();
      return state;
    },
    async connect(options) {
      if (disposed) throw new Error("disposed");
      if (options?.autoSync !== undefined) autoSync = options.autoSync;
      if (options?.authBase) {
        const endpoints = await readStoredEndpoints();
        const authBase = normalizeAuthBase(options.authBase);
        await dataAdapter.set(endpointsKey, {
          authBase,
          apiBase: apiBaseForAuthBase(authBase) || endpoints.apiBase,
        });
        // Endpoints changed: force fresh auth clients bound to them.
        if (popupMessageListener && typeof window !== "undefined") {
          window.removeEventListener("message", popupMessageListener);
          popupMessageListener = null;
        }
        authClient = null;
        popupAuthClient = null;
      }
      if (state === "connected") return state;
      // Re-entrant connect (e.g. a double-clicked button) joins the pending
      // flow instead of orphaning the first caller's promise.
      if (pendingConnectDone) return pendingConnectDone;
      const resumed = await this.resume();
      if (resumed !== "disconnected") return resumed;
      if (pendingConnectDone) return pendingConnectDone;
      const auth = await ensureAuthClients(await readStoredEndpoints());
      emitState("connecting");
      const done = new Promise<BucketState>((resolve) => {
        pendingConnect = { resolve };
      }).finally(() => {
        if (pendingConnectDone === done) pendingConnectDone = null;
      });
      pendingConnectDone = done;
      try {
        if (shouldUseSameTabAuth() || !tryOpenPopupShell()) {
          clearPopupMonitor();
          authPopupWindow = null;
          await auth.authorize({ bucketId });
          // Same-tab navigates away; resolution happens on reload via resume().
        } else {
          await popupAuthClient!.authorize({ bucketId });
        }
      } catch (error) {
        authPopupWindow?.close();
        authPopupWindow = null;
        clearPopupMonitor();
        emitState("disconnected", formatError(error));
        settlePendingConnect();
      }
      return done;
    },
    async disconnect() {
      liveTransport = null;
      liveWireId = null;
      client?.stop();
      if (authClient) await authClient.clearContext(bucketId);
      emitState("disconnected");
      settlePendingConnect();
    },
    async sync() {
      await sync();
    },
    setAutoSync(enabled) {
      autoSync = enabled;
      if (!client) return;
      if (enabled && liveTransport) startAutoSync();
      if (!enabled) client.stop();
    },
    on(event: "state" | "change", handler: (...args: never[]) => void): () => void {
      const set = listeners[event] as Set<(...args: unknown[]) => void>;
      set.add(handler as (...args: unknown[]) => void);
      return () => set.delete(handler as (...args: unknown[]) => void);
    },
    dispose() {
      disposed = true;
      client?.dispose();
      clearPopupMonitor();
      if (popupMessageListener && typeof window !== "undefined") window.removeEventListener("message", popupMessageListener);
    },
    __bindTestTransport(transport) {
      liveTransport = transport;
      liveWireId = async (appObjectId) => appObjectId;
      emitState("connected");
    },
  };
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

function addCallbackTransport(url: string, transport: "same-tab" | "popup"): string {
  const parsed = new URL(url, typeof window === "undefined" ? "https://localhost/" : window.location.href);
  parsed.searchParams.set("callbackTransport", transport);
  return parsed.toString();
}

function normalizeAuthBase(value: string): string {
  const parsed = new URL(String(value || DEFAULT_AUTH_BASE), typeof window === "undefined" ? DEFAULT_AUTH_BASE : window.location.href);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/auth") ? `${pathname}/` : `${pathname}/auth/`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function apiBaseForAuthBase(authBase: string): string {
  const parsed = new URL(authBase);
  if (parsed.hostname === "myfield.one") return DEFAULT_API_BASE;
  if (parsed.hostname === "dev.myfield.space") return "https://api-dev.myfield.space";
  if (parsed.hostname === "staging.myfield.space") return "https://api-staging.myfield.space";
  return `${parsed.protocol}//api.${parsed.host}`;
}

function shouldUseSameTabAuth(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
