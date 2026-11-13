import { createAuthorizationFlow } from "../auth/flow.ts";
import { createInstanceAuthClient, type InstanceAuthClient, type InstanceAuthContext } from "../auth/instance.ts";
import { unwrapBucketKeys } from "../bucket/keys.ts";
import { toInstanceKey, validateInstanceKey, type InstanceKey } from "../auth/keys.ts";
import { createInstanceKeyStore, authRecordKeys } from "../auth/store.ts";
import type { StorageAdapter } from "../bucket/store.ts";
import { ClientError } from "../errors.ts";
import { createHttpRequest } from "./http.ts";
import { createRemoteClient, type RemoteClient } from "./client.ts";
import type { RemoteBucket, FeedHint } from "./bucket.ts";

const DEFAULT_AUTH_URL = "https://myfield.one/auth/";
type ConnectionState = "disconnected" | "connecting" | "connected";
type StateListener = (state: ConnectionState, error?: ClientError) => void;
type ConnectionFlow = { controller: AbortController; prompt: boolean; promise: Promise<ConnectionState> };

function notAuthorized(message: string, cause?: unknown): ClientError {
  return new ClientError("NOT_AUTHORIZED", message, {
    cause,
    ...(cause instanceof ClientError ? { status: cause.status, requestId: cause.requestId } : {}),
  });
}

function isAuthorizationError(error: ClientError): boolean {
  return (error.code === "NOT_AUTHORIZED" || error.status === 401
    || error.status === 403 && ["GRANT_REVOKED", "GRANT_NOT_FOUND", "AUTH_FAILED"].includes(error.code));
}

function connectionError(error: unknown): ClientError {
  if (error instanceof ClientError) {
    if (isAuthorizationError(error)) return error.code === "NOT_AUTHORIZED" ? error : notAuthorized(error.message, error);
    if (["INVALID_STATE", "INVALID_INSTANCE_KEY", "NETWORK_ERROR"].includes(error.code)) return error;
    if (error.retryable) return new ClientError("NETWORK_ERROR", error.message, {
      cause: error, retryable: true, status: error.status, requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
    });
  }
  return new ClientError("INVALID_STATE", error instanceof Error ? error.message : "Connection failed", { cause: error });
}

function normalizeAuthUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (cause) { throw new ClientError("INVALID_INPUT", "authUrl must be an absolute HTTP(S) URL", { cause }); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ClientError("INVALID_INPUT", "authUrl must be an HTTP(S) page URL without credentials, query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}

function apiOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (cause) { throw new ClientError("NOT_AUTHORIZED", "Authorization has no valid API address", { cause }); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash
    || !["/", "/v1/api/sync", "/v1/api/sync/"].includes(url.pathname)) {
    throw new ClientError("NOT_AUTHORIZED", "Unsupported authorization API address");
  }
  return url.origin;
}

export function createInstanceConnection(deps: {
  getAppId(): string;
  data: StorageAdapter;
  auth: StorageAdapter;
  hasLegacyBucket(): boolean;
  hasActiveLocalConnection?(): boolean;
  persistent?: boolean;
}) {
  let bucketId: string, resourceId: string, endpointsKey: string;
  const storageAppId = deps.getAppId;
  let remoteClient: RemoteClient | null = null;
  let connectionController: AbortController | null = null;
  let flow: ConnectionFlow | null = null;
  let state: ConnectionState = "disconnected";
  const listeners = new Set<StateListener>();
  let forceSessionRefresh = false;
  let disconnecting: Promise<void> | null = null;
  let cleanup: Promise<void> = Promise.resolve();
  let storageQueue: Promise<unknown> = Promise.resolve();
  let keyChanges: Promise<void> = Promise.resolve();
  let disposed = false;
  const browserAuth = createAuthorizationFlow(deps);
  const { ownCallback, handleCallback, requestAuthorization } = browserAuth;

  function assertRuntime() {
    if (disposed) throw new ClientError("INVALID_STATE", "Instance runtime has stopped");
    if (deps.hasLegacyBucket()) throw new ClientError("INVALID_STATE", "Use a separate Instance for Remote access when the same-named Local bucket exists");
  }

  function assertUsable() {
    assertRuntime();
    bucketId = storageAppId();
    resourceId = `urn:myfield:bucket:${bucketId}`;
    endpointsKey = authRecordKeys(bucketId).endpoints(bucketId);
  }

  function assertKeyMutable() {
    if (disposed || remoteClient || flow || deps.hasActiveLocalConnection?.()) {
      throw new ClientError("INVALID_STATE", "Disconnect before changing an instance key");
    }
    storageAppId();
  }

  function changeKey<T>(operation: (store: ReturnType<typeof createInstanceKeyStore>) => Promise<T>): Promise<T> {
    try { assertKeyMutable(); } catch (error) { return Promise.reject(error); }
    const result = keyChanges.then(async () => {
      await cleanup;
      assertKeyMutable();
      return operation(createInstanceKeyStore(deps.auth, storageAppId()));
    });
    keyChanges = result.then(() => {}, () => {});
    return result;
  }

  function emitState(next: ConnectionState, error?: ClientError) {
    if (state === next && !error) return;
    state = next;
    for (const listener of [...listeners]) {
      try { listener(next, error); } catch {}
    }
  }

  function queue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const next = storageQueue.then(async () => {
      signal.throwIfAborted();
      try { return await operation(); }
      catch (error) { signal.throwIfAborted(); throw connectionError(error); }
    });
    storageQueue = next.catch(() => {});
    return next;
  }

  function guardedStorage(signal: AbortSignal, appId: string): StorageAdapter {
    const keys = authRecordKeys(appId);
    const prefix = keys.prefix;
    return {
      ...(deps.auth.insertIfEmpty ? { insertIfEmpty: (prefix: string, entries: { key: string; value: unknown }[]) =>
        queue(signal, () => deps.auth.insertIfEmpty!(prefix, entries)) } : {}),
      get: key => queue(signal, () => deps.auth.get(key)),
      keys: prefix => queue(signal, () => deps.auth.keys(prefix)),
      remove: key => queue(signal, () => deps.auth.remove(key)),
      set: (key, value) => queue(signal, async () => {
        if (key.startsWith(`${prefix}context:`)) {
          const context = value as InstanceAuthContext;
          const identity = await deps.auth.get<{ instanceId: string }>(keys.active);
          signal.throwIfAborted();
          if (context.resourceId !== resourceId || identity?.instanceId !== context.instanceId) {
            throw new ClientError("NOT_AUTHORIZED", "Callback does not match the active instance and bucket");
          }
          if (!context.resourceApiUrl) throw new ClientError("NOT_AUTHORIZED", "Callback is missing its API address");
          apiOrigin(context.resourceApiUrl);
          const grant = context.bucketAccessGrant;
          const instance = await deps.auth.get<{ wrappingPrivateKey: CryptoKey }>(keys.key(context.instanceId));
          if (!grant || !instance) throw new ClientError("NOT_AUTHORIZED", "Missing bucket grant or instance key");
          const bucketKeys = await unwrapBucketKeys(grant.envelope, instance.wrappingPrivateKey);
          signal.throwIfAborted();
          if (grant.resourceId !== `urn:myfield:bucket:${bucketKeys.bucketId}`) throw new ClientError("NOT_AUTHORIZED", "Grant and bucket key identify different resources");
        }
        await deps.auth.set(key, value);

      }),
    };
  }

  function fetchFor(signal: AbortSignal): typeof fetch {
    return async (input, init) => {
      signal.throwIfAborted();
      const other = init?.signal;
      if (!other || other === signal) {
        const response = await globalThis.fetch(input, { ...init, signal });
        if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
        return response;
      }
      const controller = new AbortController();
      const signals = [signal, other];
      const abort = () => controller.abort(signals.find(item => item.aborted)?.reason);
      const detach = () => { for (const item of signals) item.removeEventListener("abort", abort); };
      for (const item of signals) {
        if (item.aborted) abort();
        else item.addEventListener("abort", abort, { once: true });
      }
      controller.signal.addEventListener("abort", detach, { once: true });
      try {
        controller.signal.throwIfAborted();
        const response = await globalThis.fetch(input, { ...init, signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        if (!response.body) { detach(); return response; }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const result = await reader.read();
              controller.signal.throwIfAborted();
              if (result.done) { detach(); output.close(); }
              else output.enqueue(result.value);
            } catch (error) { detach(); output.error(error); }
          },
          async cancel(reason) { detach(); await reader.cancel(reason); },
        });
        const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        for (const property of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, property, { value: response[property] });
        return wrapped;
      } catch (error) { detach(); throw error; }
    };
  }

  async function clearAccess(removeGrant: boolean) {
    const prefix = authRecordKeys(storageAppId()).prefix;
    const keys = await deps.auth.keys(prefix);
    const contexts: string[] = [];
    const sessions = new Set<string>([resourceId]);
    for (const key of keys.filter(key => key.startsWith(`${prefix}context:`))) {
      const context = await deps.auth.get<InstanceAuthContext>(key);
      if (context?.resourceId !== resourceId) continue;
      sessions.add(context.remoteResourceId || resourceId);
      contexts.push(key);
    }
    for (const key of keys.filter(key => key.startsWith(`${prefix}session:`))) {
      const session = await deps.auth.get<{ resourceId: string }>(key);
      if (session && sessions.has(session.resourceId)) await deps.auth.remove(key);
    }
    if (!removeGrant) return;
    for (const key of contexts) await deps.auth.remove(key);
    for (const key of keys) {
      if (!key.startsWith(`${prefix}pending-auth:`) && !key.startsWith(`${prefix}callback-pointer:`)) continue;
      const pending = await deps.auth.get<{ resourceId: string }>(key);
      if (pending?.resourceId === resourceId) await deps.auth.remove(key);
    }
  }

  function invalidate(controller: AbortController, error: ClientError) {
    if (connectionController !== controller) return cleanup;
    remoteClient = null;
    connectionController = null;
    forceSessionRefresh = true;
    cleanup = cleanup.catch(() => {}).then(() => storageQueue).then(() => clearAccess(false));
    controller.abort(error);
    emitState("disconnected", error);
    return cleanup;
  }

  async function establish(current: ConnectionFlow): Promise<ConnectionState> {
    const controller = current.controller;
    const signal = controller.signal;
    signal.throwIfAborted();
    if (typeof window === "undefined") throw new ClientError("INVALID_STATE", "Connecting requires a browser");
    const stored = await deps.data.get<{ authBase?: string }>(endpointsKey);
    signal.throwIfAborted();
    const storage = guardedStorage(signal, storageAppId());
    let authorizationPopup: Window | null = null;
    let authUrl = DEFAULT_AUTH_URL;
    const makeAuth = (apiBase?: string) => createInstanceAuthClient({
      appId: storageAppId(), apiBase, storage,
      fetchImpl: apiBase ? (input, init) => {
        const url = new URL(String(input));
        return createHttpRequest({ apiBase, fetch: fetchFor(signal) })(url.pathname + url.search, init || {});
      } : fetchFor(signal),
      origin: window.location.origin,
      redirectUri: window.location.origin + window.location.pathname,
      authPageUrl: authUrl,
      openAuthUrl: target => {
        signal.throwIfAborted();
        const parsed = new URL(target);
        parsed.searchParams.set("callbackTransport", authorizationPopup ? "popup" : "same-tab");
        if (authorizationPopup) authorizationPopup.location.href = parsed.href;
        else window.location.href = parsed.href;
      },
    });
    let auth = makeAuth();
    let context = await auth.getContext(bucketId);
    if (context) authUrl = normalizeAuthUrl(stored?.authBase || DEFAULT_AUTH_URL);

    const publish = async (next: InstanceAuthContext, approved: boolean) => {
      signal.throwIfAborted();
      emitState("connecting");
      const apiBase = apiOrigin(next.resourceApiUrl || "");
      if (approved) await queue(signal, () => deps.data.set(endpointsKey, { authBase: authUrl, apiBase }));
      auth = makeAuth(apiBase);
      let access;
      try { access = await auth.getBucketAccess(bucketId); }
      catch (error) { signal.throwIfAborted(); throw notAuthorized("Bucket authorization is unusable", error); }
      if (access.resourceId !== `urn:myfield:bucket:${access.bucketId}`) throw notAuthorized("Grant and bucket key identify different resources");
      const getCredential = async () => {
        signal.throwIfAborted();
        let session;
        try { session = await auth.getSession(bucketId, { forceRefresh: forceSessionRefresh }); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof ClientError) throw connectionError(error);
          throw notAuthorized("Session response is unusable", error);
        }
        signal.throwIfAborted();
        if (!session || session.carrier !== "bearer" || typeof session.token !== "string" || !session.token) throw notAuthorized("A bearer session is required");
        forceSessionRefresh = false;
        return { token: session.token };
      };
      await getCredential();
      signal.throwIfAborted();
      remoteClient = createRemoteClient({ apiBase, mfid: access.mfid, bucketId: access.bucketId, getCredential, fetch: fetchFor(signal) });
      emitState("connected");
      signal.throwIfAborted();
      return state;
    };

    try {
      const pageUrl = new URL(window.location.href);
      let approved = false;
      if (await ownCallback(pageUrl, storage)) {
        emitState("connecting");
        await handleCallback(auth, pageUrl, signal, true);
        approved = true;
        context = await auth.getContext(bucketId);
      }
      if (context) return await publish(context, approved);
    } catch (error) {
      signal.throwIfAborted();
      const failure = connectionError(error);
      if (failure.code !== "NOT_AUTHORIZED" || !current.prompt) throw failure;
      forceSessionRefresh = true;
      await queue(signal, () => clearAccess(false));
    }
    signal.throwIfAborted();
    if (!current.prompt) { emitState("disconnected"); return "disconnected"; }
    emitState("connecting");
    auth = makeAuth();
    await requestAuthorization(auth, storage, authUrl, signal, popup => { authorizationPopup = popup; });
    context = await auth.getContext(bucketId);
    if (!context) throw notAuthorized("Authorization context unavailable");
    return publish(context, true);
  }

  async function invoke<T>(operation: (bucket: RemoteBucket) => Promise<T>): Promise<T> {
    assertUsable();
    if (!remoteClient || !connectionController) throw notAuthorized("Call instance.connect() before Remote operations");
    const client = remoteClient;
    return handleOperation(connectionController, () => operation(client.getBucket()));
  }

  async function handleOperation<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ClientError && isAuthorizationError(error)) {
        const failure = notAuthorized(error.message, error);
        await invalidate(controller, failure);
        throw failure;
      }
      throw error;
    }
  }

  const remote: RemoteBucket = {
    getCurrent: (...args) => invoke(bucket => bucket.getCurrent(...args)),
    getVersion: (...args) => invoke(bucket => bucket.getVersion(...args)),
    getVersionMeta: (...args) => invoke(bucket => bucket.getVersionMeta(...args)),
    getPayload: (...args) => invoke(bucket => bucket.getPayload(...args)),
    commit: (...args) => invoke(bucket => bucket.commit(...args)),
    getIndex: (...args) => invoke(bucket => bucket.getIndex(...args)),
    listFeed: (...args) => invoke(bucket => bucket.listFeed(...args)),
    listVersions: (...args) => invoke(bucket => bucket.listVersions(...args)),
    async watchFeed(options) {
      assertUsable();
      if (!remoteClient || !connectionController) throw notAuthorized("Call instance.connect() before Remote operations");
      const controller = connectionController;
      const client = remoteClient;
      const stream = await handleOperation(controller, () => client.getBucket().watchFeed(options)).catch(error => {
        controller.signal.throwIfAborted();
        throw error;
      });
      if (controller.signal.aborted) {
        await stream.return(undefined);
        controller.signal.throwIfAborted();
      }
      const watched: AsyncGenerator<FeedHint> = {
        async next() {
          try {
            controller.signal.throwIfAborted();
            const next = await handleOperation(controller, () => stream.next());
            controller.signal.throwIfAborted();
            return next;
          } catch (error) {
            await stream.return(undefined);
            controller.signal.throwIfAborted();
            throw error;
          }
        },
        return: value => stream.return(value),
        throw: error => stream.throw(error),
        [Symbol.asyncIterator]() { return watched; },
      };
      const asyncDispose = Reflect.get(Symbol, "asyncDispose");
      if (typeof asyncDispose === "symbol") {
        Object.defineProperty(watched, asyncDispose, { value: async () => { await stream.return(undefined); } });
      }
      return watched;
    },
  };

  function start(prompt: boolean, args: unknown[]): Promise<ConnectionState> {
    if (args.length) return Promise.reject(new ClientError("INVALID_INPUT", "Connection methods take no arguments"));
    try { assertUsable(); } catch (error) { return Promise.reject(error); }
    if (remoteClient) return Promise.resolve("connected");
    if (flow) { flow.prompt ||= prompt; return flow.promise; }
    const controller = new AbortController();
    const current: ConnectionFlow = { controller, prompt, promise: null! };
    connectionController = controller;
    current.promise = Promise.all([cleanup, keyChanges]).then(() => establish(current)).catch(async error => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const failure = connectionError(error);
      controller.abort(failure);
      if (failure.code === "NOT_AUTHORIZED") {
        forceSessionRefresh = true;
        cleanup = cleanup.catch(() => {}).then(() => storageQueue).then(() => clearAccess(false));
        await cleanup;
      }
      if (connectionController === controller) {
        connectionController = null;
        remoteClient = null;
        emitState("disconnected", failure);
      }
      if (failure.code === "INVALID_INSTANCE_KEY" && !current.prompt) return "disconnected" as const;
      throw failure;
    }).finally(() => { if (flow === current) flow = null; });
    flow = current;
    return current.promise;
  }

  function stop(reason: unknown) {
    const controller = connectionController;
    connectionController = null;
    remoteClient = null;
    flow = null;
    controller?.abort(reason);
    browserAuth.close();
  }

  return {
    get state() { return state; },
    on(event: "state", listener: StateListener) {
      assertRuntime();
      if (event !== "state" || typeof listener !== "function") throw new ClientError("INVALID_INPUT", "A state listener is required");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    remote: { getBucket: (...args: unknown[]) => {
      assertUsable();
      if (args.length) throw new ClientError("INVALID_INPUT", "getBucket takes no arguments");
      return remote;
    } },
    async getKey(): Promise<InstanceKey | null> {
      if (disposed) throw new ClientError("INVALID_STATE", "Instance runtime has stopped");
      const appId = storageAppId();
      await keyChanges;
      const key = await createInstanceKeyStore(deps.auth, appId).active();
      return key ? toInstanceKey(key) : null;
    },
    createKey: () => changeKey(async store => toInstanceKey(await store.create(assertKeyMutable))),
    importKey: (key: InstanceKey) => changeKey(async store => {
      const validated = await validateInstanceKey(key);
      assertKeyMutable();
      await store.import(validated);
    }),
    removeKey: () => changeKey(store => store.remove()),
    resume: (...args: unknown[]) => start(false, args),
    connect: (...args: unknown[]) => start(true, args),
    disconnect(): Promise<void> {
      try { assertUsable(); } catch (error) { return Promise.reject(error); }
      stop(new DOMException("Connection disconnected", "AbortError"));
      if (disconnecting) { emitState("disconnected"); return disconnecting; }
      const operation = cleanup.catch(() => {}).then(() => storageQueue).then(() => clearAccess(true)).finally(() => {
        if (disconnecting === operation) disconnecting = null;
      });
      cleanup = operation;
      disconnecting = operation;
      emitState("disconnected");
      return operation;
    },
    block() {
      stop(new ClientError("INVALID_STATE", "The same-named Local bucket exists"));
      emitState("disconnected", new ClientError("INVALID_STATE", "The same-named Local bucket exists"));
    },
    dispose() {
      disposed = true;
      stop(new DOMException("Instance runtime stopped", "AbortError"));
      state = "disconnected";
      listeners.clear();
    },
  };
}
