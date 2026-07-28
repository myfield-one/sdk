// Bucket key material. The callback-provided bucket access grant wraps a raw
// 256-bit bucket key to the instance wrapping key (ECDH + HKDF + AES-GCM).
// The SDK unwraps the raw bytes once, derives two independent subkeys, and
// discards the raw bytes:
//   - payload key: AES-GCM-256 for object payload envelopes (wire compatible
//     with the established bucket sync envelope format).
//   - object-id key: HMAC-SHA-256 for deterministic object-id blinding.
//
// Id derivation is part of the SDK bucket format contract: every SDK
// version/language must derive identical wire ids for the same bucket.
//   idKey  = HKDF-SHA-256(ikm = raw bucket key, salt = "myfield.sdk.v1",
//                         info = "object-id|" + bucketId)
//   wireId = "ob_" + hex(HMAC-SHA-256(idKey, utf8(appObjectId)))[0..32)

import { b64urlToBytes, bytesToHex, utf8Encode } from "../internal/encoding.ts";

export const ID_BLINDING_SALT = "myfield.sdk.v1";
export const ID_BLINDING_INFO_PREFIX = "object-id|";
export const WIRE_ID_PREFIX = "ob_";
export const WIRE_ID_HEX_LENGTH = 32;

export type BucketKeys = {
  bucketId: string;
  keyId: string;
  payloadKey: CryptoKey;
  wireObjectId: (appObjectId: string) => Promise<string>;
};

export type BucketKeyGrantEnvelope = {
  kind: "bucket-key";
  bucketId: string;
  keyId: string;
  targetInstanceId: string;
  targetWrappingPublicJwk: JsonWebKey;
  ephemeralPublicJwk: JsonWebKey;
  wrapAlg: "ECDH-HKDF-SHA-256/AES-GCM-256";
  salt: string;
  iv: string;
  aad: string;
  ciphertext: string;
};

export async function deriveBucketKeysFromRaw(bucketId: string, keyId: string, rawKey: Uint8Array): Promise<BucketKeys> {
  if (rawKey.length !== 32) throw new Error("bucket key must be 256-bit");
  const rawBuffer = rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer;
  const payloadKey = await crypto.subtle.importKey("raw", rawBuffer, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const hkdfMaterial = await crypto.subtle.importKey("raw", rawBuffer, "HKDF", false, ["deriveKey"]);
  const idKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8Encode(ID_BLINDING_SALT),
      info: utf8Encode(`${ID_BLINDING_INFO_PREFIX}${bucketId}`),
    },
    hkdfMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const wireIdCache = new Map<string, string>();
  return {
    bucketId,
    keyId,
    payloadKey,
    async wireObjectId(appObjectId: string): Promise<string> {
      const safe = String(appObjectId || "");
      if (!safe) throw new Error("objectId required");
      const cached = wireIdCache.get(safe);
      if (cached) return cached;
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", idKey, utf8Encode(safe)));
      const wireId = `${WIRE_ID_PREFIX}${bytesToHex(mac).slice(0, WIRE_ID_HEX_LENGTH)}`;
      wireIdCache.set(safe, wireId);
      return wireId;
    },
  };
}

// Unwraps the raw bucket key from a grant envelope, derives the subkeys, and
// lets the raw bytes go out of scope. Uses decrypt (not unwrapKey) because the
// raw bytes are needed as HKDF input for the id key.
export async function unwrapBucketKeys(envelope: BucketKeyGrantEnvelope, instanceWrappingPrivateKey: CryptoKey): Promise<BucketKeys> {
  const ephemeralPublic = await crypto.subtle.importKey("jwk", envelope.ephemeralPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublic }, instanceWrappingPrivateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: b64urlToBytes(envelope.salt) as BufferSource, info: utf8Encode(envelope.aad) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(envelope.iv) as BufferSource, additionalData: utf8Encode(envelope.aad) },
      wrappingKey,
      b64urlToBytes(envelope.ciphertext) as BufferSource
    )
  );
  try {
    return await deriveBucketKeysFromRaw(envelope.bucketId, envelope.keyId, raw);
  } finally {
    raw.fill(0);
  }
}
