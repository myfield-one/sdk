import { createInstanceAuthClient, type InstanceAuthClient, type InstanceAuthContext } from "../auth/instance.ts";
import { unwrapBucketKeys } from "../bucket/keys.ts";
import type { StorageAdapter } from "../bucket/store.ts";
import { ClientError } from "../errors.ts";
import { createHttpRequest } from "./http.ts";
import { createRemoteClient, type RemoteClient } from "./client.ts";
import type { RemoteBucket } from "./bucket.ts";

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
    if (error.code === "NOT_AUTHORIZED" || error.code === "INVALID_STATE" || error.code === "NETWORK_ERROR") return error;
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
  namespace: string;
  data: StorageAdapter;
  auth: StorageAdapter;
  hasLegacyBucket(): boolean;
  persistent?: boolean;
}) {
  const bucketId = deps.namespace;
  const resourceId = `urn:myfield:bucket:${bucketId}`;
  const endpointsKey = `meta:${bucketId}:endpoints`;
  const storageAppId = () => {
    const host = typeof window === "undefined" ? "myfield.sdk" : window.location.hostname;
    return /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(host) && !host.includes("..") ? host : "myfield.sdk";
  };
  let remoteClient: RemoteClient | null = null;
  let connectionController: AbortController | null = null;
  let flow: ConnectionFlow | null = null;
  let state: ConnectionState = "disconnected";
  const listeners = new Set<StateListener>();
  let forceSessionRefresh = false;
  let disconnecting: Promise<void> | null = null;
  let cleanup: Promise<void> = Promise.resolve();
  let storageQueue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let closeAuthorization = () => {};

  function assertUsable() {
    if (disposed) throw new ClientError("INVALID_STATE", "Instance runtime has stopped");
    if (deps.hasLegacyBucket()) throw new ClientError("INVALID_STATE", "Use a separate Instance for Remote access when the same-named Local bucket exists");
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
    const prefix = `instance:${encodeURIComponent(appId)}:`;
    return {
      get: key => queue(signal, () => deps.auth.get(key)),
      keys: prefix => queue(signal, () => deps.auth.keys(prefix)),
      remove: key => queue(signal, () => deps.auth.remove(key)),
      set: (key, value) => queue(signal, async () => {
        if (key.startsWith(`${prefix}context:`)) {
          const context = value as InstanceAuthContext;
          const identity = await deps.auth.get<{ instanceId: string }>(`${prefix}active-instance:current`);
          signal.throwIfAborted();
          if (context.resourceId !== resourceId || identity?.instanceId !== context.instanceId) {
            throw new ClientError("NOT_AUTHORIZED", "Callback does not match the active instance and bucket");
          }
          if (!context.resourceApiUrl) throw new ClientError("NOT_AUTHORIZED", "Callback is missing its API address");
          apiOrigin(context.resourceApiUrl);
          const grant = context.bucketAccessGrant;
          const instance = await deps.auth.get<{ wrappingPrivateKey: CryptoKey }>(`${prefix}instance-key:${encodeURIComponent(context.instanceId)}`);
          if (!grant || !instance) throw new ClientError("NOT_AUTHORIZED", "Missing bucket grant or instance key");
          const keys = await unwrapBucketKeys(grant.envelope, instance.wrappingPrivateKey);
          signal.throwIfAborted();
          if (grant.resourceId !== `urn:myfield:bucket:${keys.bucketId}`) throw new ClientError("NOT_AUTHORIZED", "Grant and bucket key identify different resources");
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

  async function ownCallback(url: URL, storage: StorageAdapter): Promise<boolean> {
    const requestId = url.searchParams.get("mf_request_id");
    if (!requestId) return false;
    const prefix = `instance:${encodeURIComponent(storageAppId())}:`;
    const pointer = await storage.get<{ resourceId: string; pendingKey: string; requestId: string }>(`${prefix}callback-pointer:${encodeURIComponent(requestId)}`);
    if (pointer?.resourceId !== resourceId || pointer.requestId !== requestId) return false;
    const pending = await storage.get<{ resourceId: string }>(pointer.pendingKey);
    if (pending && pending.resourceId !== resourceId) return false;
    return true;
  }

  function clearCallbackUrl(url: URL) {
    const current = new URL(window.location.href);
    if (current.searchParams.get("mf_request_id") !== url.searchParams.get("mf_request_id")) return;
    for (const key of ["state", "error", "error_description", "error_uri", "mf_request_id", "mf_result"]) current.searchParams.delete(key);
    const hash = new URLSearchParams(current.hash.slice(1));
    if (hash.has("mf_auth_result")) { hash.delete("mf_auth_result"); current.hash = hash.toString(); }
    window.history.replaceState(null, "", current.href);
  }

  async function handleCallback(auth: InstanceAuthClient, url: URL, signal: AbortSignal, addressBar: boolean) {
    try {
      const result = await auth.handleCallback(url.href);
      signal.throwIfAborted();
      if (result?.result !== "approved") throw notAuthorized(result?.errorDescription || result?.result || "Invalid authorization callback");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ClientError && error.code === "NOT_AUTHORIZED") throw error;
      throw notAuthorized("Invalid authorization callback", error);
    } finally {
      if (addressBar) clearCallbackUrl(url);
    }
  }

  function requestAuthorization(auth: InstanceAuthClient, storage: StorageAdapter, url: string, signal: AbortSignal, setPopup: (popup: Window | null) => void): Promise<void> {
    signal.throwIfAborted();
    const ios = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    const popup = ios ? null : window.open("about:blank", "myfield-sdk-auth", "popup=yes,width=520,height=720");
    if (!popup && deps.persistent === false) throw new ClientError("INVALID_STATE", "Redirect authorization requires persistent storage");
    setPopup(popup);
    return new Promise<void>((resolve, reject) => {
      let processing = false;
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
        popup?.close();
        closeAuthorization = () => {};
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(signal.reason);
      const onMessage = (event: MessageEvent) => {
        if (!popup || event.source !== popup || ![new URL(url).origin, window.location.origin].includes(event.origin)) return;
        const message = event.data as { type?: string; callbackUrl?: string } | null;
        if (!message || message.type !== "myfield.auth.callback" || typeof message.callbackUrl !== "string") return;
        void (async () => {
          let callbackUrl: URL;
          try { callbackUrl = new URL(message.callbackUrl!); } catch { return; }
          if (!await ownCallback(callbackUrl, storage) || processing || settled) return;
          processing = true;
          await handleCallback(auth, callbackUrl, signal, false);
          finish();
        })().catch(finish);
      };
      window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      closeAuthorization = onAbort;
      if (popup) timer = setInterval(() => {
        if (popup.closed && !processing) finish(notAuthorized("Authorization window closed"));
      }, 250);
      void auth.authorize({ bucketId }).catch(finish);
    });
  }

  async function clearAccess(removeGrant: boolean) {
    const prefix = `instance:${encodeURIComponent(storageAppId())}:`;
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
    const controller = connectionController;
    try { return await operation(remoteClient.getBucket()); }
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
  };

  function start(prompt: boolean, args: unknown[]): Promise<ConnectionState> {
    if (args.length) return Promise.reject(new ClientError("INVALID_INPUT", "Connection methods take no arguments"));
    try { assertUsable(); } catch (error) { return Promise.reject(error); }
    if (remoteClient) return Promise.resolve("connected");
    if (flow) { flow.prompt ||= prompt; return flow.promise; }
    const controller = new AbortController();
    const current: ConnectionFlow = { controller, prompt, promise: null! };
    connectionController = controller;
    current.promise = cleanup.then(() => establish(current)).catch(async error => {
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
    closeAuthorization();
  }

  return {
    get state() { return state; },
    on(event: "state", listener: StateListener) {
      assertUsable();
      if (event !== "state" || typeof listener !== "function") throw new ClientError("INVALID_INPUT", "A state listener is required");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    remote: { getBucket: (...args: unknown[]) => {
      assertUsable();
      if (args.length) throw new ClientError("INVALID_INPUT", "getBucket takes no arguments");
      return remote;
    } },
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
