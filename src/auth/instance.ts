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

import {
  b64urlToBytes,
  bytesToB64url,
  bytesToHex,
  normalizeIsoDateTime,
  randomId,
  sha256Hex,
  stableStringify,
  utf8Encode,
} from "../internal/encoding.ts";
import { unwrapBucketKeys, type BucketKeyGrantEnvelope, type BucketKeys } from "../bucket/keys.ts";
import { createIndexedDbStorageAdapter, type StorageAdapter } from "../bucket/store.ts";

export type AuthCapability = "read" | "write";

export type AuthInstance = {
  v: 1;
  instanceId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  wrappingPublicJwk: JsonWebKey;
  wrappingPrivateKey: CryptoKey;
  createdAt: string;
};

export type InstanceAuthContext = {
  v: 1;
  mfid: string;
  resourceId: string;
  remoteResourceId?: string;
  resourceApiUrl?: string;
  instanceId: string;
  requestId: string;
  authorizedAt: string;
  bucketAccessGrant?: BucketAccessGrant;
};

export type CloudSessionCredential =
  | { carrier: "bearer"; token: string; expiresAt: string }
  | { carrier: "cookie"; expiresAt: string };

export type BucketAccess = {
  mfid: string;
  instanceId: string;
  bucketId: string;
  resourceId: string;
  resourceApiUrl?: string;
  capabilities: AuthCapability[];
  grantRecordId: string;
  keys: BucketKeys;
};

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

export type AuthCallbackResult = {
  requestId: string;
  state: string;
  result: "approved" | "denied" | "error";
  resourceId?: string;
  error?: string;
  errorDescription?: string;
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

export type BucketAccessGrant = {
  v: 1;
  grantRecordId: string;
  mfid: string;
  resourceId: string;
  instanceId: string;
  issuedAt: string;
  keyId: string;
  capabilities: AuthCapability[];
  envelope: BucketKeyGrantEnvelope;
};

type StoredAuthAuthorizationResult = {
  v: 1;
  requestId: string;
  state: string;
  result: "approved";
  mfid: string;
  resourceId: string;
  instanceId: string;
  createdAt: string;
  resourceApiUrl?: string;
  bucketAccessGrant?: BucketAccessGrant;
  expiresAt?: string;
};

type EncryptedAuthAuthorizationResultEnvelope = {
  v: 1;
  typ: "auth.authorization-result.envelope.v1";
  alg: "ECDH-HKDF-SHA-256/AES-GCM-256";
  requestId: string;
  state: string;
  resourceId: string;
  instanceId: string;
  ephemeralPublicJwk: JsonWebKey;
  salt: string;
  iv: string;
  aad: string;
  ciphertext: string;
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

type StoredAuthInstance = AuthInstance & { updatedAt: string };
type ActiveInstancePointer = { v: 1; instanceId: string; updatedAt: string };

type StoredCloudSessionCredential = {
  v: 1;
  mfid: string;
  resourceId: string;
  instanceId: string;
  credential: CloudSessionCredential;
  storedAt?: string;
};

type InstanceProof = {
  type: "instance.es256";
  instanceId: string;
  alg: "ES256";
  signedAt: string;
  signature: string;
};

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CALLBACK_FRAGMENT_PARAM = "mf_auth_result";
const DEFAULT_AUTH_IDB_NAME = "mf-sdk-auth-v1";
const BUCKET_ACCESS_CACHE_TTL_MS = 60_000;
const INSTANCE_SESSION_USABLE_WINDOW_MS = 2 * 60 * 1000;
const INSTANCE_SESSION_BEST_EFFORT_REFRESH_WINDOW_MS = 60 * 60 * 1000;
const FIXED_CAPABILITIES: AuthCapability[] = ["read", "write"];

export function createInstanceAuthClient(options: InstanceAuthClientOptions = {}): InstanceAuthClient {
  let instance: AuthInstance | null = null;
  const appId = normalizeInstanceAppId(options.appId);
  let mfid = "";
  let currentResourceId = "";
  let currentSession: { resourceId: string; credential: CloudSessionCredential } | null = null;
  const inFlightSessionRefreshes = new Map<string, Promise<CloudSessionCredential>>();
  const storage = options.storage || createIndexedDbStorageAdapter({ dbName: DEFAULT_AUTH_IDB_NAME, storeName: "instance" });
  const fetchImpl = options.fetchImpl || fetch;
  const bucketAccessCache = new Map<string, { access: BucketAccess; expiresAt: number }>();

  const activeInstanceKey = () => `instance:${seg(appId)}:active-instance:current`;
  const instanceKey = (instanceId: string) => `instance:${seg(appId)}:instance-key:${seg(instanceId)}`;
  const pendingAuthKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:pending-auth:${seg(resourceId)}:${seg(instanceId)}`;
  const callbackPointerKey = (requestId: string) => `instance:${seg(appId)}:callback-pointer:${seg(requestId)}`;
  const contextKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:context:${seg(resourceId)}:${seg(instanceId)}`;
  const sessionKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:session:${seg(resourceId)}:${seg(instanceId)}`;

  function isStoredAuthInstance(value: StoredAuthInstance | null, instanceId?: string): value is StoredAuthInstance {
    return (
      !!value &&
      value.v === 1 &&
      isValidInstanceId(value.instanceId) &&
      (!instanceId || value.instanceId === instanceId) &&
      value.signingPrivateKey instanceof CryptoKey &&
      value.wrappingPrivateKey instanceof CryptoKey
    );
  }

  async function readStoredInstance(instanceId: string): Promise<StoredAuthInstance | null> {
    const stored = await storage.get<StoredAuthInstance>(instanceKey(instanceId));
    return isStoredAuthInstance(stored, instanceId) ? stored : null;
  }

  async function writeStoredInstance(authInstance: AuthInstance): Promise<StoredAuthInstance> {
    const existing = await readStoredInstance(authInstance.instanceId);
    const stored: StoredAuthInstance = {
      ...authInstance,
      updatedAt: new Date().toISOString(),
      createdAt: authInstance.createdAt || existing?.createdAt || new Date().toISOString(),
    };
    await storage.set(instanceKey(authInstance.instanceId), stored);
    const verified = await readStoredInstance(authInstance.instanceId);
    if (!verified) throw new Error("auth instance write did not persist keys");
    await storage.set(activeInstanceKey(), { v: 1, instanceId: authInstance.instanceId, updatedAt: new Date().toISOString() } satisfies ActiveInstancePointer);
    instance = verified;
    return verified;
  }

  async function readActiveStoredInstance(): Promise<StoredAuthInstance | null> {
    const active = await storage.get<ActiveInstancePointer>(activeInstanceKey());
    if (!active || active.v !== 1 || !isValidInstanceId(active.instanceId)) return null;
    return readStoredInstance(active.instanceId);
  }

  async function ensureStoredInstance(): Promise<StoredAuthInstance> {
    if (instance) {
      const stored = await readStoredInstance(instance.instanceId);
      if (stored) return stored;
      return writeStoredInstance(instance);
    }
    const active = await readActiveStoredInstance();
    if (active) {
      instance = active;
      return active;
    }
    return writeStoredInstance(await generateAuthInstance());
  }

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
    instance = authInstance;
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
      const challenge = await postJson<{ challengeId: string; challenge: string }>(fetchImpl, options.apiBase, "/v1/api/auth/instance-challenge", {
        mfid,
        resourceId: sessionResourceId,
        instanceId: authInstance.instanceId,
      });
      const proof = await signInstanceChallenge({
        instance: authInstance,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        mfid,
        resourceId: sessionResourceId,
      });
      const session = await postJson<{ credential: CloudSessionCredential }>(fetchImpl, options.apiBase, "/v1/api/auth/instance-session", {
        mfid,
        resourceId: sessionResourceId,
        instanceId: authInstance.instanceId,
        challengeId: challenge.challengeId,
        proof,
        credentialCarrier: "bearer",
      });
      currentSession = { resourceId: sessionResourceId, credential: session.credential };
      if (session.credential.carrier === "bearer") {
        await storage.set(sessionKey(sessionResourceId, context.instanceId), {
          v: 1,
          mfid,
          resourceId: sessionResourceId,
          instanceId: authInstance.instanceId,
          credential: session.credential,
          storedAt: new Date().toISOString(),
        } satisfies StoredCloudSessionCredential);
      }
      return session.credential;
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
        await writeStoredInstance(authInstance);
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

async function generateAuthInstance(): Promise<AuthInstance> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const wrapping = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const signingPublicJwk = (await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey;
  const wrappingPublicJwk = (await crypto.subtle.exportKey("jwk", wrapping.publicKey)) as JsonWebKey;
  return {
    v: 1,
    instanceId: await deriveInstanceId(signingPublicJwk),
    signingPublicJwk,
    signingPrivateKey: signing.privateKey,
    wrappingPublicJwk,
    wrappingPrivateKey: wrapping.privateKey,
    createdAt: new Date().toISOString(),
  };
}

async function deriveInstanceId(signingPublicJwk: JsonWebKey): Promise<string> {
  const digest = await sha256Hex(stableStringify(jwkCore(signingPublicJwk)));
  return `inst_${digest.slice(0, 32)}`;
}

export async function signInstanceChallenge(input: {
  instance: Pick<AuthInstance, "instanceId" | "signingPrivateKey">;
  challenge: string;
  mfid: string;
  resourceId: string;
  challengeId?: string;
  signedAt?: string;
}): Promise<InstanceProof> {
  const signedAt = normalizeIsoDateTime(input.signedAt) || new Date().toISOString();
  const payload = stableStringify({
    v: 1,
    type: "instance-proof",
    instanceId: input.instance.instanceId,
    challenge: input.challenge,
    challengeId: input.challengeId || "",
    mfid: input.mfid,
    resourceId: input.resourceId,
    signedAt,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.instance.signingPrivateKey, utf8Encode(payload));
  return { type: "instance.es256", instanceId: input.instance.instanceId, alg: "ES256", signedAt, signature: bytesToB64url(new Uint8Array(signature)) };
}

type AuthRequestFields = {
  clientId: string;
  requestId: string;
  state: string;
  redirectUri: string;
  origin: string;
  resourceId: string;
  capabilities: AuthCapability[];
  instanceId: string;
  instanceSigningPublicJwk: JsonWebKey;
  instanceWrappingPublicJwk: JsonWebKey;
  createdAt: string;
};

function buildAuthRequestFragment(request: AuthRequestFields): string {
  if (!request.requestId || !request.state) throw new Error("auth request state required");
  if (!isValidInstanceId(request.instanceId)) throw new Error("invalid instanceId");
  if (!isPublicP256EcJwk(request.instanceSigningPublicJwk)) throw new Error("instanceSigningPublicJwk required");
  if (!isPublicP256EcJwk(request.instanceWrappingPublicJwk)) throw new Error("instanceWrappingPublicJwk required");
  const redirect = new URL(request.redirectUri);
  const origin = new URL(request.origin);
  if (redirect.origin !== origin.origin) throw new Error("redirectUri origin mismatch");
  const wire = {
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    scope: request.capabilities.join(" "),
    resource_id: request.resourceId,
    mf_v: 1,
    mf_auth_mode: "v1",
    mf_request_id: request.requestId,
    mf_instance_id: request.instanceId,
    mf_instance_signing_jwk: request.instanceSigningPublicJwk,
    mf_instance_wrapping_jwk: request.instanceWrappingPublicJwk,
    mf_issued_at: request.createdAt,
  };
  return `#authRequest=${bytesToB64url(utf8Encode(stableStringify(wire)))}`;
}

function parseEncryptedAuthAuthorizationResultFragment(fragmentOrUrl: string): EncryptedAuthAuthorizationResultEnvelope | null {
  const input = String(fragmentOrUrl || "");
  const rawFragment = input.includes("#") ? input.slice(input.indexOf("#") + 1) : input.replace(/^#/, "");
  if (!rawFragment) return null;
  const encoded = new URLSearchParams(rawFragment).get(AUTH_CALLBACK_FRAGMENT_PARAM);
  if (!encoded) return null;
  const envelope = JSON.parse(new TextDecoder().decode(b64urlToBytes(encoded))) as Partial<EncryptedAuthAuthorizationResultEnvelope> | null;
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.typ !== "auth.authorization-result.envelope.v1" ||
    envelope.alg !== "ECDH-HKDF-SHA-256/AES-GCM-256" ||
    typeof envelope.requestId !== "string" ||
    typeof envelope.state !== "string" ||
    !parseBucketResourceId(envelope.resourceId) ||
    !isValidInstanceId(envelope.instanceId || "") ||
    !isPublicP256EcJwk(envelope.ephemeralPublicJwk) ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.aad !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("auth callback result fragment invalid");
  }
  return envelope as EncryptedAuthAuthorizationResultEnvelope;
}

export async function decryptEncryptedAuthAuthorizationResult(input: {
  envelope: EncryptedAuthAuthorizationResultEnvelope;
  instanceWrappingPrivateKey: CryptoKey;
  expectedRequestId?: string;
  expectedState?: string;
  expectedResourceId?: string;
  expectedInstanceId?: string;
}): Promise<StoredAuthAuthorizationResult> {
  const { envelope } = input;
  if (
    (input.expectedRequestId && envelope.requestId !== input.expectedRequestId) ||
    (input.expectedState && envelope.state !== input.expectedState) ||
    (input.expectedResourceId && envelope.resourceId !== input.expectedResourceId) ||
    (input.expectedInstanceId && envelope.instanceId !== input.expectedInstanceId)
  ) {
    throw new Error("auth callback result mismatch");
  }
  const ephemeralPublic = await crypto.subtle.importKey("jwk", envelope.ephemeralPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublic }, input.instanceWrappingPrivateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: b64urlToBytes(envelope.salt) as BufferSource, info: utf8Encode(envelope.aad) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(envelope.iv) as BufferSource, additionalData: utf8Encode(envelope.aad) },
    wrappingKey,
    b64urlToBytes(envelope.ciphertext) as BufferSource
  );
  const result = normalizeAuthAuthorizationResult(JSON.parse(new TextDecoder().decode(plaintext)), envelope.requestId);
  if (
    !result ||
    result.state !== envelope.state ||
    result.resourceId !== envelope.resourceId ||
    result.instanceId !== envelope.instanceId ||
    (input.expectedState && result.state !== input.expectedState) ||
    (input.expectedResourceId && result.resourceId !== input.expectedResourceId) ||
    (input.expectedInstanceId && result.instanceId !== input.expectedInstanceId)
  ) {
    throw new Error("auth callback result mismatch");
  }
  return result;
}

function normalizeAuthAuthorizationResult(value: unknown, expectedRequestId?: string): StoredAuthAuthorizationResult | null {
  const row = value as Partial<StoredAuthAuthorizationResult> | null;
  if (
    !row ||
    row.v !== 1 ||
    row.result !== "approved" ||
    typeof row.requestId !== "string" ||
    (expectedRequestId && row.requestId !== expectedRequestId) ||
    typeof row.state !== "string" ||
    !isValidMfid(row.mfid || "") ||
    !parseBucketResourceId(row.resourceId) ||
    !isValidInstanceId(row.instanceId || "") ||
    typeof row.createdAt !== "string"
  ) {
    return null;
  }
  if (row.expiresAt !== undefined) {
    const expiresAt = Date.parse(String(row.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }
  const resource = parseBucketResourceId(row.resourceId);
  if (!resource) return null;
  const bucketAccessGrant = normalizeBucketAccessGrant(row.bucketAccessGrant);
  if (!bucketAccessGrant) return null;
  if (bucketAccessGrant.mfid !== row.mfid || !parseBucketResourceId(bucketAccessGrant.resourceId) || bucketAccessGrant.instanceId !== row.instanceId) {
    return null;
  }
  return {
    v: 1,
    requestId: row.requestId,
    state: row.state,
    result: "approved",
    mfid: row.mfid!,
    resourceId: resource.resourceId,
    instanceId: row.instanceId!,
    createdAt: row.createdAt,
    ...(typeof row.resourceApiUrl === "string" && row.resourceApiUrl.trim() ? { resourceApiUrl: row.resourceApiUrl.trim() } : {}),
    bucketAccessGrant,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
  };
}

export function normalizeBucketAccessGrant(value: unknown): BucketAccessGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<BucketAccessGrant>;
  const resource = parseBucketResourceId(row.resourceId);
  const capabilities = normalizeCapabilities(row.capabilities);
  if (
    row.v !== 1 ||
    !/^ar_[a-f0-9]{32}$/.test(String(row.grantRecordId || "")) ||
    !isValidMfid(row.mfid) ||
    !resource ||
    !isValidInstanceId(row.instanceId) ||
    !/^bk_[a-f0-9]{32}$/.test(String(row.keyId || "")) ||
    capabilities.length < 1 ||
    !isValidBucketKeyGrantEnvelope(row.envelope, row.instanceId, row.keyId)
  ) {
    return null;
  }
  return {
    v: 1,
    grantRecordId: row.grantRecordId!,
    mfid: row.mfid!,
    resourceId: resource.resourceId,
    instanceId: row.instanceId!,
    issuedAt: String(row.issuedAt || ""),
    keyId: row.keyId!,
    capabilities,
    envelope: row.envelope as BucketKeyGrantEnvelope,
  };
}

function isValidBucketKeyGrantEnvelope(value: unknown, instanceId?: string, keyId?: string): value is BucketKeyGrantEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<BucketKeyGrantEnvelope>;
  if (
    row.kind !== "bucket-key" ||
    !isValidBucketId(row.bucketId) ||
    !/^bk_[a-f0-9]{32}$/.test(String(row.keyId || "")) ||
    !isValidInstanceId(row.targetInstanceId) ||
    row.wrapAlg !== "ECDH-HKDF-SHA-256/AES-GCM-256" ||
    !isPublicP256EcJwk(row.targetWrappingPublicJwk) ||
    !isPublicP256EcJwk(row.ephemeralPublicJwk) ||
    typeof row.salt !== "string" ||
    typeof row.iv !== "string" ||
    typeof row.aad !== "string" ||
    typeof row.ciphertext !== "string"
  ) {
    return false;
  }
  if (instanceId && row.targetInstanceId !== instanceId) return false;
  if (keyId && row.keyId !== keyId) return false;
  return true;
}

export function bucketResourceId(bucketId: string): string {
  return `urn:myfield:bucket:${bucketId}`;
}

function parseBucketResourceId(resourceId: unknown): { resourceId: string; bucketId: string } | null {
  const safe = typeof resourceId === "string" ? resourceId.trim() : "";
  const prefix = "urn:myfield:bucket:";
  if (!safe.startsWith(prefix)) return null;
  const bucketId = safe.slice(prefix.length);
  return isValidBucketId(bucketId) ? { resourceId: safe, bucketId } : null;
}

function normalizeCapabilities(input: unknown): AuthCapability[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<AuthCapability>(["read", "write"]);
  const result: AuthCapability[] = [];
  for (const item of input) {
    if (allowed.has(item as AuthCapability) && !result.includes(item as AuthCapability)) result.push(item as AuthCapability);
  }
  return result.sort();
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

export function isValidBucketId(value: unknown): value is string {
  const safe = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(safe) && !safe.includes("..");
}

function requireValidBucketId(value: unknown): string {
  if (!isValidBucketId(value)) throw new Error("invalid bucketId");
  return value;
}

function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^inst_[a-f0-9]{32}$/.test(value);
}

function isValidMfid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isPublicP256EcJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwk = value as JsonWebKey;
  return jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && jwk.x.length > 0 && typeof jwk.y === "string" && jwk.y.length > 0;
}

function normalizeInstanceAppId(value: unknown): string {
  const safe = typeof value === "string" ? value.trim() : "";
  return isValidBucketId(safe) ? safe : "myfield.sdk";
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function jwkCore(jwk: JsonWebKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["kty", "crv", "x", "y", "kid", "alg", "use"] as const) {
    const value = (jwk as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function browserLocationHref(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.href;
}

function browserLocationOrigin(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.origin;
}
