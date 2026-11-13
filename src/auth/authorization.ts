import { b64urlToBytes, bytesToB64url, stableStringify, utf8Encode } from "../internal/encoding.ts";
import type { BucketKeyGrantEnvelope } from "../bucket/keys.ts";
import type { AuthCapability, BucketAccessGrant } from "./types.ts";
import { isValidBucketId, isValidInstanceId, isValidMfid, isPublicP256EcJwk, parseBucketResourceId } from "./identifiers.ts";

const AUTH_CALLBACK_FRAGMENT_PARAM = "mf_auth_result";

export type StoredAuthAuthorizationResult = {
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

export type EncryptedAuthAuthorizationResultEnvelope = {
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

export function buildAuthRequestFragment(request: AuthRequestFields): string {
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

export function parseEncryptedAuthAuthorizationResultFragment(fragmentOrUrl: string): EncryptedAuthAuthorizationResultEnvelope | null {
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

function normalizeCapabilities(input: unknown): AuthCapability[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<AuthCapability>(["read", "write"]);
  const result: AuthCapability[] = [];
  for (const item of input) {
    if (allowed.has(item as AuthCapability) && !result.includes(item as AuthCapability)) result.push(item as AuthCapability);
  }
  return result.sort();
}
