// AES-GCM envelope, wire compatible with the established myfield bucket sync
// envelope shape. The worker only validates envelope shape (zero-knowledge
// storage); it never decrypts payloads. AAD binds bucketId and the blinded
// wire object id.

import { b64urlToBytes, bytesToB64url, utf8Decode, utf8Encode } from "../internal/encoding.ts";
import type { BucketKeys } from "./keys.ts";

export type EncryptedEnvelopeFields = {
  ciphertext: string;
  cipherMeta: { alg: "AES-GCM"; iv: string; keyId: string; bucketId: string; aad: string };
  wrappedDEK: string;
  wrappedDEKMeta: { alg: "direct-bucket-key"; keyId: string; bucketId: string };
};

export async function encryptEnvelopeFields(keys: BucketKeys, wireObjectId: string, plaintext: Uint8Array): Promise<EncryptedEnvelopeFields> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildAad(keys.bucketId, wireObjectId);
  const plaintextBuffer = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8Encode(aad) }, keys.payloadKey, plaintextBuffer)
  );
  return {
    ciphertext: bytesToB64url(ciphertext),
    cipherMeta: { alg: "AES-GCM", iv: bytesToB64url(iv), keyId: keys.keyId, bucketId: keys.bucketId, aad },
    wrappedDEK: keys.keyId,
    wrappedDEKMeta: { alg: "direct-bucket-key", keyId: keys.keyId, bucketId: keys.bucketId },
  };
}

export async function decryptEnvelope(keys: BucketKeys, wireObjectId: string, envelope: Uint8Array): Promise<Uint8Array> {
  const parsed = JSON.parse(utf8Decode(envelope)) as {
    cipherMeta?: { alg?: unknown; iv?: unknown; keyId?: unknown; bucketId?: unknown; aad?: unknown };
    ciphertext?: unknown;
  };
  if (
    typeof parsed.ciphertext !== "string" ||
    parsed.cipherMeta?.alg !== "AES-GCM" ||
    parsed.cipherMeta.keyId !== keys.keyId ||
    parsed.cipherMeta.bucketId !== keys.bucketId ||
    typeof parsed.cipherMeta.iv !== "string" ||
    typeof parsed.cipherMeta.aad !== "string"
  ) {
    throw new Error("corrupted sync envelope");
  }
  if (parsed.cipherMeta.aad !== buildAad(keys.bucketId, wireObjectId)) throw new Error("sync envelope aad mismatch");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(parsed.cipherMeta.iv) as BufferSource, additionalData: utf8Encode(parsed.cipherMeta.aad) },
      keys.payloadKey,
      b64urlToBytes(parsed.ciphertext) as BufferSource
    )
  );
}

function buildAad(bucketId: string, wireObjectId: string): string {
  return `myfield.bucket.sync.v1|${bucketId}|${wireObjectId}`;
}
