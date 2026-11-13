import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "../src/index.ts";
import { createInstanceKey } from "../src/auth/keys.ts";
import { createNamespacedMemoryStorageAdapter } from "../src/bucket/store.ts";

const key = await createInstanceKey(), other = await createInstanceKey();
const extractable = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const wrongCurve = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, false, ["deriveBits"]);
const invalid = [
  ["null", null],
  ["missing fields", {}],
  ["wrong ID", { ...key, instanceId: other.instanceId }],
  ["signing pair mismatch", { ...key, signingPrivateKey: other.signingPrivateKey }],
  ["wrapping pair mismatch", { ...key, wrappingPrivateKey: other.wrappingPrivateKey }],
  ["wrong algorithm", { ...key, signingPrivateKey: key.wrappingPrivateKey }],
  ["wrong curve", { ...key, wrappingPrivateKey: wrongCurve.privateKey }],
  ["public instead of private", { ...key, signingPrivateKey: extractable.publicKey }],
  ["extractable private key", { ...key, signingPrivateKey: extractable.privateKey }],
  ["missing wrapping JWK", { ...key, wrappingPublicJwk: null }],
  ["invalid creation time", { ...key, createdAt: "yesterday" }],
  ["numeric creation time", { ...key, createdAt: 123 }],
];
for (const [index, [label, value]] of invalid.entries()) {
  test(`importKey rejects ${label} before writing records`, async () => {
    const appId = `invalid-${index}.example.com`;
    const instance = createInstance({ appId, storage: "memory" });
    await assert.rejects(instance.importKey(value), error => error.code === "INVALID_INPUT");
    const storage = createNamespacedMemoryStorageAdapter(`myfield-sdk:${appId}`);
    assert.deepEqual(await storage.keys(""), []);
  });
}

test("windowless Local CRUD remains available without implicit appId or identity generation", async () => {
  const instance = createInstance({ storage: "memory", namespace: "windowless" });
  const bucket = instance.createBucket({ id: "local.example.com" });
  await bucket.put("note", { text: "offline" });
  assert.equal((await bucket.get("note")).text, "offline");
  await assert.rejects(instance.resume(), error => error.code === "INVALID_INPUT");
  await assert.rejects(instance.importKey(key), error => error.code === "INVALID_INPUT");
  const storage = createNamespacedMemoryStorageAdapter("myfield-sdk:windowless");
  assert.deepEqual(await storage.keys("auth:"), []);
  bucket.dispose();
});

test("memory key lifecycle persists across handles and recovers explicitly without replacing Local data", async () => {
  const options = { appId: "memory-keys.example.com", storage: "memory" };
  const instance = createInstance(options);
  assert.equal(await instance.getKey(), null);
  const created = await instance.createKey();
  const reopened = createInstance(options);
  assert.equal((await reopened.getKey()).instanceId, created.instanceId);
  await assert.rejects(reopened.createKey(), error => error.code === "KEY_EXISTS");
  const local = reopened.createBucket({ id: "local.example.com" });
  await local.put("note", { text: "keep" });
  await reopened.removeKey(); await reopened.removeKey();
  assert.equal(await instance.getKey(), null);
  await instance.importKey(created);
  assert.equal((await reopened.getKey()).instanceId, created.instanceId);
  assert.equal((await local.get("note")).text, "keep");
  local.dispose();
});
