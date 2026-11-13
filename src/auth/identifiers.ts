import { ClientError } from "../errors.ts";

export function isValidBucketId(value: unknown): value is string {
  const safe = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(safe) && !safe.includes("..");
}

export function requireValidBucketId(value: unknown): string {
  if (!isValidBucketId(value)) throw new Error("invalid bucketId");
  return value;
}

export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^inst_[a-f0-9]{32}$/.test(value);
}

export function isValidMfid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function isPublicP256EcJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwk = value as JsonWebKey;
  return jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && jwk.x.length > 0 && typeof jwk.y === "string" && jwk.y.length > 0;
}

export function bucketResourceId(bucketId: string): string {
  return `urn:myfield:bucket:${bucketId}`;
}

export function parseBucketResourceId(resourceId: unknown): { resourceId: string; bucketId: string } | null {
  const safe = typeof resourceId === "string" ? resourceId.trim() : "";
  const prefix = "urn:myfield:bucket:";
  if (!safe.startsWith(prefix)) return null;
  const bucketId = safe.slice(prefix.length);
  return isValidBucketId(bucketId) ? { resourceId: safe, bucketId } : null;
}

export function resolveAppId(value?: string): string {
  const appId = value === undefined ? (typeof window === "undefined" ? "" : window.location.hostname) : value;
  if (typeof appId !== "string" || appId !== appId.trim() || !isValidBucketId(appId)
    || !appId.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ClientError("INVALID_INPUT", "appId must be a lowercase domain-form identifier of 1–63 characters");
  }
  return appId;
}
