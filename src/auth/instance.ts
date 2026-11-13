// Instance auth client for the open surface, ported from the notepad
// prototype and trimmed to the open contract:
//   - bucket resources only, fixed read+write capabilities
//   - SDK v1 authorization (`mf_auth_mode=v1` is always sent); the
//     app-visible mfid is a pairwise alias, never the owner mfid
//   - exactly two API routes: instance-challenge and instance-session
//     (alias mode has no grant refetch; bucket access rides on the
//     callback-provided bucketAccessGrant)
// The /auth fragment wire format is frozen as-is, including its vestigial
// OAuth-shaped fields; this module hides it from apps entirely.

import { bytesToHex, randomId } from "../internal/encoding.ts";
import { unwrapBucketKeys } from "../bucket/keys.ts";
import { createIndexedDbStorageAdapter, type StorageAdapter } from "../bucket/store.ts";
import type { AuthInstance } from "./keys.ts";
import { createInstanceKeyStore } from "./store.ts";
import { ClientError } from "../errors.ts";
import type { AuthCapability, InstanceAuthContext, BucketAccess, AuthCallbackResult, BucketAccessGrant } from "./types.ts";
import { buildAuthRequestFragment, parseEncryptedAuthAuthorizationResultFragment, decryptEncryptedAuthAuthorizationResult,
  normalizeBucketAccessGrant, type StoredAuthAuthorizationResult, type EncryptedAuthAuthorizationResultEnvelope } from "./authorization.ts";
import { bucketResourceId, parseBucketResourceId, requireValidBucketId, isValidMfid, resolveAppId } from "./identifiers.ts";
import { createSessionClient } from "../remote/session.ts";
import { createSession, type CloudSessionCredential } from "./session.ts";

export type { AuthCapability, InstanceAuthContext, BucketAccess, AuthCallbackResult, BucketAccessGrant } from "./types.ts";
export { decryptEncryptedAuthAuthorizationResult, normalizeBucketAccessGrant } from "./authorization.ts";
export { bucketResourceId, isValidBucketId } from "./identifiers.ts";
export type { AuthInstance } from "./keys.ts";
export type { CloudSessionCredential } from "./session.ts";
export { signInstanceChallenge } from "./proof.ts";

export type InstanceAuthClientOptions = {
  appId?: string;
  apiBase?: string;
  authPageUrl?: string;
  redirectUri?: string;
  origin?: string;
  openAuthUrl?: (url: string) => void | Promise<void>;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
};

export type InstanceAuthClient = {
  ensureInstance(): Promise<AuthInstance>;
  authorize(request: { bucketId: string }): Promise<void>;
  handleCallback(url?: string): Promise<AuthCallbackResult | null>;
  getContext(bucketId: string): Promise<InstanceAuthContext | null>;
  getSession(bucketId: string, options?: { forceRefresh?: boolean }): Promise<CloudSessionCredential>;
  getBucketAccess(bucketId: string): Promise<BucketAccess>;
  clearContext(bucketId: string): Promise<void>;
};

type PendingInstanceAuthRequest = {
  v: 1;
  requestId: string;
  state: string;
  resourceId: string;
  capabilities: AuthCapability[];
  instanceId: string;
};

type InstanceAuthCallbackPointer = {
  v: 1;
  requestId: string;
  resourceId: string;
  instanceId: string;
  pendingKey: string;
  createdAt: string;
};

type StoredCloudSessionCredential = {
  v: 1;
  mfid: string;
  resourceId: string;
  instanceId: string;
  credential: CloudSessionCredential;
  storedAt?: string;
};

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AUTH_IDB_NAME = "mf-sdk-auth-v1";
const BUCKET_ACCESS_CACHE_TTL_MS = 60_000;
const INSTANCE_SESSION_USABLE_WINDOW_MS = 2 * 60 * 1000;
const INSTANCE_SESSION_BEST_EFFORT_REFRESH_WINDOW_MS = 60 * 60 * 1000;
const FIXED_CAPABILITIES: AuthCapability[] = ["read", "write"];

export function createInstanceAuthClient(options: InstanceAuthClientOptions = {}): InstanceAuthClient {
  const appId = resolveAppId(options.appId);
  let mfid = "";
  let currentResourceId = "";
  let currentSession: { resourceId: string; credential: CloudSessionCredential } | null = null;
  const inFlightSessionRefreshes = new Map<string, Promise<CloudSessionCredential>>();
  const storage = options.storage || createIndexedDbStorageAdapter({ dbName: DEFAULT_AUTH_IDB_NAME, storeName: "instance" });
  const fetchImpl = options.fetchImpl || fetch;
  const sessions = createSessionClient((path, body) => postJson(fetchImpl, options.apiBase, path, body));
  const bucketAccessCache = new Map<string, { access: BucketAccess; expiresAt: number }>();

  const keyStore = createInstanceKeyStore(storage, appId);
  const { pending: pendingAuthKey, callback: callbackPointerKey, context: contextKey, session: sessionKey } = keyStore.keys;
  const readStoredInstance = keyStore.read;
  const readActiveStoredInstance = keyStore.active;
  const ensureStoredInstance = keyStore.ensure;

  async function readContext(resourceId: string): Promise<InstanceAuthContext | null> {
    if (!parseBucketResourceId(resourceId)) return null;
    const authInstance = await readActiveStoredInstance();
    if (!authInstance) return null;
    const context = await storage.get<InstanceAuthContext>(contextKey(resourceId, authInstance.instanceId));
    if (
      !context ||
      context.v !== 1 ||
      !isValidMfid(context.mfid) ||
      context.resourceId !== resourceId ||
      (context.remoteResourceId !== undefined && !parseBucketResourceId(context.remoteResourceId)) ||
      context.instanceId !== authInstance.instanceId
    ) {
      return null;
    }
    mfid = context.mfid;
    currentResourceId = context.resourceId;
    return context;
  }

  async function getSessionForResource(resourceId: string, sessionOptions?: { forceRefresh?: boolean }): Promise<CloudSessionCredential> {
    const context = await readContext(resourceId);
    if (!mfid || !context) throw new Error("not authorized; complete an auth callback first");
    const authInstance = await ensureStoredInstance();
    if (authInstance.instanceId !== context.instanceId) throw new Error("stored instance does not match authorization context");
    const sessionResourceId = context.remoteResourceId || context.resourceId;
    const forceRefresh = sessionOptions?.forceRefresh === true;
    const refreshSessionKey = `${sessionResourceId}:${authInstance.instanceId}`;

    const performRefreshSession = async (): Promise<CloudSessionCredential> => {
      const credential = await createSession({ instance: authInstance, mfid, resourceId: sessionResourceId }, sessions);
      currentSession = { resourceId: sessionResourceId, credential };
      if (credential.carrier === "bearer") {
        await storage.set(sessionKey(sessionResourceId, context.instanceId), {
          v: 1,
          mfid,
          resourceId: sessionResourceId,
          instanceId: authInstance.instanceId,
          credential,
          storedAt: new Date().toISOString(),
        } satisfies StoredCloudSessionCredential);
      }
      return credential;
    };

    const refreshSession = (): Promise<CloudSessionCredential> => {
      const inFlight = inFlightSessionRefreshes.get(refreshSessionKey);
      if (inFlight) return inFlight;
      const promise = performRefreshSession().finally(() => {
        if (inFlightSessionRefreshes.get(refreshSessionKey) === promise) inFlightSessionRefreshes.delete(refreshSessionKey);
      });
      inFlightSessionRefreshes.set(refreshSessionKey, promise);
      return promise;
    };

    if (!forceRefresh) {
      let cachedCredential: CloudSessionCredential | null = null;
      if (currentSession?.resourceId === sessionResourceId && isSessionUsable(currentSession.credential)) {
        cachedCredential = currentSession.credential;
      } else {
        const stored = await storage.get<StoredCloudSessionCredential>(sessionKey(sessionResourceId, context.instanceId));
        if (
          stored?.v === 1 &&
          stored.mfid === mfid &&
          stored.resourceId === sessionResourceId &&
          stored.instanceId === authInstance.instanceId &&
          isSessionUsable(stored.credential)
        ) {
          currentSession = { resourceId: sessionResourceId, credential: stored.credential };
          cachedCredential = stored.credential;
        }
      }
      if (cachedCredential) {
        if (shouldBestEffortRefreshSession(cachedCredential)) void refreshSession().catch(() => undefined);
        return cachedCredential;
      }
    }

    if (forceRefresh) inFlightSessionRefreshes.delete(refreshSessionKey);
    return refreshSession();
  }

  return {
    async ensureInstance() {
      return ensureStoredInstance();
    },
    async authorize(request) {
      const resourceId = bucketResourceId(requireValidBucketId(request.bucketId));
      const authInstance = await ensureStoredInstance();
      currentResourceId = resourceId;
      const state = randomId("state");
      const requestId = randomId("req");
      const nextPendingKey = pendingAuthKey(resourceId, authInstance.instanceId);
      const fragment = buildAuthRequestFragment({
        clientId: appId,
        requestId,
        state,
        redirectUri: options.redirectUri || browserLocationHref(),
        origin: options.origin || browserLocationOrigin(),
        resourceId,
        capabilities: FIXED_CAPABILITIES,
        instanceId: authInstance.instanceId,
        instanceSigningPublicJwk: authInstance.signingPublicJwk,
        instanceWrappingPublicJwk: authInstance.wrappingPublicJwk,
        createdAt: new Date().toISOString(),
      });
      await storage.set(nextPendingKey, {
        v: 1,
        requestId,
        state,
        resourceId,
        capabilities: FIXED_CAPABILITIES,
        instanceId: authInstance.instanceId,
      } satisfies PendingInstanceAuthRequest);
      await storage.set(callbackPointerKey(requestId), {
        v: 1,
        requestId,
        resourceId,
        instanceId: authInstance.instanceId,
        pendingKey: nextPendingKey,
        createdAt: new Date().toISOString(),
      } satisfies InstanceAuthCallbackPointer);
      const authPageUrl = String(options.authPageUrl || "").trim();
      if (!authPageUrl) throw new Error("authPageUrl is required to authorize an instance");
      const authUrl = `${authPageUrl}${fragment}`;
      if (options.openAuthUrl) {
        await options.openAuthUrl(authUrl);
        return;
      }
      if (typeof window === "undefined") throw new Error("browser window required for authorize redirect");
      window.location.href = authUrl;
    },
    async handleCallback(url) {
      const parsed = url && /^[a-z][a-z0-9+.-]*:/i.test(url) ? new URL(url) : new URL(url || browserLocationHref(), browserLocationOrigin());
      let encryptedEnvelope: EncryptedAuthAuthorizationResultEnvelope | null = null;
      let encryptedEnvelopeInvalid = false;
      try {
        encryptedEnvelope = parseEncryptedAuthAuthorizationResultFragment(parsed.hash);
      } catch {
        encryptedEnvelopeInvalid = true;
      }
      const result: AuthCallbackResult = {
        requestId: parsed.searchParams.get("mf_request_id") || "",
        state: parsed.searchParams.get("state") || "",
        result: (parsed.searchParams.get("mf_result") || (parsed.searchParams.get("error") ? "error" : "")) as AuthCallbackResult["result"],
        ...(parsed.searchParams.get("error") ? { error: parsed.searchParams.get("error") || undefined } : {}),
        ...(parsed.searchParams.get("error_description") ? { errorDescription: parsed.searchParams.get("error_description") || undefined } : {}),
      };
      if (!result.requestId || !result.state || !["approved", "denied", "error"].includes(result.result)) return null;
      const pointer = await storage.get<InstanceAuthCallbackPointer>(callbackPointerKey(result.requestId));
      if (!pointer || pointer.v !== 1 || pointer.requestId !== result.requestId || !isFresh(pointer.createdAt)) return null;
      const expected = await storage.get<PendingInstanceAuthRequest>(pointer.pendingKey);
      if (!expected || expected.v !== 1 || expected.requestId !== result.requestId || expected.state !== result.state) return null;
      result.resourceId = expected.resourceId;
      if (result.result === "approved") {
        if (encryptedEnvelopeInvalid || !encryptedEnvelope) {
          return { ...result, result: "error", error: "server_error", errorDescription: "authorization_result_invalid" };
        }
        const authInstance = await readStoredInstance(expected.instanceId);
        if (!authInstance) return { ...result, result: "error", error: "server_error", errorDescription: "authorization_instance_missing" };
        let stored: StoredAuthAuthorizationResult;
        try {
          stored = await decryptEncryptedAuthAuthorizationResult({
            envelope: encryptedEnvelope,
            instanceWrappingPrivateKey: authInstance.wrappingPrivateKey,
            expectedRequestId: result.requestId,
            expectedState: result.state,
            expectedResourceId: expected.resourceId,
            expectedInstanceId: expected.instanceId,
          });
        } catch {
          return { ...result, result: "error", error: "server_error", errorDescription: "authorization_result_invalid" };
        }
        if (stored.resourceId !== pointer.resourceId || stored.instanceId !== pointer.instanceId) {
          return { ...result, result: "error", error: "server_error", errorDescription: "authorization_context_mismatch" };
        }
        const remoteResourceId = stored.bucketAccessGrant?.resourceId || stored.resourceId;
        mfid = stored.mfid;
        currentResourceId = stored.resourceId;
        if ((await readActiveStoredInstance())?.instanceId !== authInstance.instanceId) {
          throw new ClientError("IDENTITY_MISMATCH", "Active instance changed during authorization");
        }
        await storage.set(contextKey(stored.resourceId, stored.instanceId), {
          v: 1,
          mfid: stored.mfid,
          resourceId: stored.resourceId,
          ...(remoteResourceId !== stored.resourceId ? { remoteResourceId } : {}),
          ...(stored.resourceApiUrl ? { resourceApiUrl: stored.resourceApiUrl } : {}),
          instanceId: stored.instanceId,
          requestId: result.requestId,
          authorizedAt: new Date().toISOString(),
          ...(stored.bucketAccessGrant ? { bucketAccessGrant: stored.bucketAccessGrant } : {}),
        } satisfies InstanceAuthContext);
        if (currentSession?.resourceId === remoteResourceId) currentSession = null;
        await storage.remove(sessionKey(remoteResourceId, stored.instanceId));
        bucketAccessCache.clear();
      }
      await storage.remove(pointer.pendingKey);
      await storage.remove(callbackPointerKey(result.requestId));
      return result;
    },
    getContext: (bucketId) => readContext(bucketResourceId(requireValidBucketId(bucketId))),
    getSession: (bucketId, sessionOptions) => getSessionForResource(bucketResourceId(requireValidBucketId(bucketId)), sessionOptions),
    async getBucketAccess(bucketId) {
      const safeBucketId = requireValidBucketId(bucketId);
      const resourceId = bucketResourceId(safeBucketId);
      const context = await readContext(resourceId);
      if (!mfid || !context) throw new Error("not authorized; complete an auth callback first");
      const authInstance = await ensureStoredInstance();
      if (authInstance.instanceId !== context.instanceId) throw new Error("stored instance does not match authorization context");
      const cacheKey = `${mfid}:${safeBucketId}:${authInstance.instanceId}`;
      const cached = bucketAccessCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.access;
      const grant = normalizeBucketAccessGrant(context.bucketAccessGrant);
      const remoteResourceId = context.remoteResourceId || resourceId;
      if (!grant || grant.mfid !== mfid || grant.instanceId !== authInstance.instanceId || grant.resourceId !== remoteResourceId) {
        throw new Error("bucket access grant unavailable; reauthorize required");
      }
      const keys = await unwrapBucketKeys(grant.envelope, authInstance.wrappingPrivateKey);
      const access: BucketAccess = {
        mfid,
        instanceId: authInstance.instanceId,
        bucketId: keys.bucketId,
        resourceId: remoteResourceId,
        ...(context.resourceApiUrl ? { resourceApiUrl: context.resourceApiUrl } : {}),
        capabilities: grant.capabilities,
        grantRecordId: grant.grantRecordId,
        keys,
      };
      bucketAccessCache.set(cacheKey, { access, expiresAt: Date.now() + BUCKET_ACCESS_CACHE_TTL_MS });
      return access;
    },
    async clearContext(bucketId) {
      const resourceId = bucketResourceId(requireValidBucketId(bucketId));
      const authInstance = await readActiveStoredInstance();
      if (authInstance) {
        await storage.remove(contextKey(resourceId, authInstance.instanceId));
        await storage.remove(sessionKey(resourceId, authInstance.instanceId));
      }
      if (currentResourceId === resourceId || !authInstance) {
        mfid = "";
        currentResourceId = "";
        currentSession = null;
        bucketAccessCache.clear();
      }
    },
  };
}

async function postJson<T>(fetchImpl: typeof fetch, apiBase: string | undefined, path: string, body: unknown): Promise<T> {
  const res = await fetchImpl(`${apiBase || ""}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed: ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

function getSessionRemainingMs(session: CloudSessionCredential | null): number | null {
  if (!session || session.carrier !== "bearer") return null;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt - Date.now() : null;
}

function isSessionUsable(session: CloudSessionCredential | null): session is CloudSessionCredential {
  const remainingMs = getSessionRemainingMs(session);
  return remainingMs !== null && remainingMs > INSTANCE_SESSION_USABLE_WINDOW_MS;
}

function shouldBestEffortRefreshSession(session: CloudSessionCredential): boolean {
  const remainingMs = getSessionRemainingMs(session);
  return remainingMs !== null && remainingMs > INSTANCE_SESSION_USABLE_WINDOW_MS && remainingMs <= INSTANCE_SESSION_BEST_EFFORT_REFRESH_WINDOW_MS;
}

function isFresh(createdAt: string): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && Date.now() - created <= AUTH_REQUEST_TTL_MS;
}

function browserLocationHref(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.href;
}

function browserLocationOrigin(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.origin;
}
