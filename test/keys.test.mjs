import assert from "node:assert/strict";
import test from "node:test";

import { deriveBucketKeysFromRaw, unwrapBucketKeys, WIRE_ID_PREFIX } from "../src/bucket/keys.ts";
import { decryptEnvelope, encryptEnvelopeFields } from "../src/bucket/crypto.ts";
import { applyLwwMapUpdates, emptyLwwMapDoc, encodePayloadDoc, LwwClock } from "../src/bucket/format.ts";
import { canonicalizeFieldMap, createBucketBinaryValue } from "../src/bucket/binary.ts";

const RAW_A = new Uint8Array(32).fill(7);
const RAW_B = new Uint8Array(32).fill(8);

test("wire id derivation is deterministic per (key, bucket, object)", async () => {
  const keys1 = await deriveBucketKeysFromRaw("app.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_A));
  const keys2 = await deriveBucketKeysFromRaw("app.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_A));
  const idA = await keys1.wireObjectId("note:1");
  assert.equal(idA, await keys2.wireObjectId("note:1"), "same inputs derive the same wire id");
  assert.match(idA, new RegExp(`^${WIRE_ID_PREFIX}[0-9a-f]{32}$`));
  assert.notEqual(idA, await keys1.wireObjectId("note:2"), "different app object id");
  const otherBucket = await deriveBucketKeysFromRaw("other.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_A));
  assert.notEqual(idA, await otherBucket.wireObjectId("note:1"), "different bucket id");
  const otherKey = await deriveBucketKeysFromRaw("app.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_B));
  assert.notEqual(idA, await otherKey.wireObjectId("note:1"), "different key material");
});

test("envelope roundtrip and aad binding", async () => {
  const keys = await deriveBucketKeysFromRaw("app.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_A));
  const wireId = await keys.wireObjectId("note:1");
  const plaintext = new TextEncoder().encode("hello");
  const fields = await encryptEnvelopeFields(keys, wireId, plaintext);
  const envelope = new TextEncoder().encode(JSON.stringify(fields));
  const decrypted = await decryptEnvelope(keys, wireId, envelope);
  assert.deepEqual(new Uint8Array(decrypted), plaintext);
  const otherWireId = await keys.wireObjectId("note:2");
  await assert.rejects(() => decryptEnvelope(keys, otherWireId, envelope), /aad mismatch/);
});

test("binary payload envelope tampering fails decrypt", async () => {
  const keys = await deriveBucketKeysFromRaw("app.example.com", "bk_" + "0".repeat(32), new Uint8Array(RAW_A));
  const wireId = await keys.wireObjectId("file:1");
  const doc = applyLwwMapUpdates(
    emptyLwwMapDoc(),
    await canonicalizeFieldMap({ content: createBucketBinaryValue(new Uint8Array([1, 2, 3, 4])) }),
    new LwwClock(),
    "actor-1"
  );
  const fields = await encryptEnvelopeFields(keys, wireId, encodePayloadDoc(doc));
  const ciphertext = Buffer.from(fields.ciphertext, "base64url");
  ciphertext[0] = (ciphertext[0] || 0) ^ 1;
  fields.ciphertext = ciphertext.toString("base64url");
  const envelope = new TextEncoder().encode(JSON.stringify(fields));
  await assert.rejects(
    () => decryptEnvelope(keys, wireId, envelope),
    (error) => error instanceof Error && (error.name === "OperationError" || /operation/i.test(error.message))
  );
});

test("grant envelope unwrap derives working keys", async () => {
  const instanceWrapping = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rawBucketKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = "myfield.auth.grant.bucket-key.v1|app.example.com";

  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: instanceWrapping.publicKey }, ephemeral.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(aad) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, wrapKey, rawBucketKey)
  );
  const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

  const envelope = {
    kind: "bucket-key",
    bucketId: "app.example.com",
    keyId: "bk_" + "1".repeat(32),
    targetInstanceId: "inst_" + "2".repeat(32),
    targetWrappingPublicJwk: await crypto.subtle.exportKey("jwk", instanceWrapping.publicKey),
    ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    wrapAlg: "ECDH-HKDF-SHA-256/AES-GCM-256",
    salt: b64url(salt),
    iv: b64url(iv),
    aad,
    ciphertext: b64url(ciphertext),
  };

  const unwrapped = await unwrapBucketKeys(envelope, instanceWrapping.privateKey);
  const direct = await deriveBucketKeysFromRaw("app.example.com", envelope.keyId, rawBucketKey);
  assert.equal(await unwrapped.wireObjectId("note:1"), await direct.wireObjectId("note:1"), "unwrapped key matches raw derivation");

  const wireId = await unwrapped.wireObjectId("note:1");
  const fields = await encryptEnvelopeFields(unwrapped, wireId, new TextEncoder().encode("payload"));
  const decrypted = await decryptEnvelope(direct, wireId, new TextEncoder().encode(JSON.stringify(fields)));
  assert.equal(new TextDecoder().decode(decrypted), "payload");
});
