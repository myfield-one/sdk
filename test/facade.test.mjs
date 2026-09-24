// Executable specification for the §6 public facade (docs/API.md).
//
// This file is wired into `npm test` and is the reviewable contract for the
// facade. Assertion changes mean the contract moved and need a doc/plan
// update first.
//
// Test seams assumed from the implementation (internal, not public API):
//   - createInstance({ storage: "memory" }) keeps data in a per-process
//     registry keyed by namespace, so re-creating an instance with the same
//     namespace sees the same data and a different namespace does not.
//   - bucket.__bindTestTransport(transport, wireObjectId?) binds a
//     BucketTransportLike (e.g. test/helpers.mjs createMockRelay()) as if
//     connect() had succeeded, without running the auth flow. Auth/consent
//     itself is covered by the browser e2e, not by this file.

import assert from "node:assert/strict";
import test from "node:test";

import { createInstance } from "../src/index.ts";
import { isBucketBinaryValue } from "../src/bucket/binary.ts";
import { BucketClient } from "../src/bucket/client.ts";
import { decodePayloadDoc, encodePayloadDoc } from "../src/bucket/format.ts";
import { createMemoryStorage, createMockRelay } from "./helpers.mjs";

let seq = 0;
function makeBucket(relay, { namespace } = {}) {
  const instance = createInstance({ namespace: namespace ?? `facadespec${(seq += 1)}`, storage: "memory" });
  const bucket = instance.createBucket({ id: "spec.example.com" });
  if (relay) bucket.__bindTestTransport(relay.transport());
  return bucket;
}

// ---- local-first ----------------------------------------------------------

test("local CRUD works with no connection and no account", async () => {
  const bucket = makeBucket(null);
  await bucket.ready();
  await bucket.put("note:1", { title: "hello", body: "world" });
  assert.deepEqual(await bucket.get("note:1"), { title: "hello", body: "world" });
  await bucket.update("note:1", { body: "updated" });
  assert.deepEqual(await bucket.get("note:1"), { title: "hello", body: "updated" });
  const rows = await bucket.list({ prefix: "note:" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "note:1");
  assert.ok(typeof rows[0].updatedAt === "string");
  await bucket.delete("note:1");
  assert.equal(await bucket.get("note:1"), null);
  assert.deepEqual(await bucket.list(), []);
});

test("sync() while disconnected rejects with NotConnectedError; local ops never do", async () => {
  const bucket = makeBucket(null);
  await bucket.put("note:1", { title: "offline fine" });
  await assert.rejects(() => bucket.sync(), (error) => error.name === "NotConnectedError");
  assert.deepEqual(await bucket.get("note:1"), { title: "offline fine" });
});

test("binary field values roundtrip through the public bucket API", async () => {
  const bucket = makeBucket(null);
  await bucket.put("file:1", {
    kind: "file",
    name: "hello.txt",
    content: bucket.binary(new TextEncoder().encode("hello"), { mimeType: "text/plain", name: "hello.txt" }),
  });
  const file = await bucket.get("file:1");
  assert.equal(file.kind, "file");
  assert.equal(file.name, "hello.txt");
  assert.ok(isBucketBinaryValue(file.content));
  assert.equal(file.content.size, 5);
  assert.equal(file.content.mimeType, "text/plain");
  assert.equal(file.content.name, "hello.txt");
  assert.equal(new TextDecoder().decode(await file.content.arrayBuffer()), "hello");
  assert.equal(await (await file.content.blob()).text(), "hello");
});

test("binary field values sync through existing object routes", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  const b = makeBucket(relay);
  await a.put("file:1", { content: a.binary(new Uint8Array([9, 8, 7])) });
  await a.sync();
  await b.sync();
  const file = await b.get("file:1");
  assert.ok(isBucketBinaryValue(file.content));
  assert.deepEqual(new Uint8Array(await file.content.arrayBuffer()), new Uint8Array([9, 8, 7]));
});

test("same binary field value does not bump the list entry", async () => {
  const bucket = makeBucket(null);
  const bytes = new Uint8Array([1, 2, 3]);
  await bucket.put("file:1", { content: bucket.binary(bytes) });
  const before = (await bucket.list())[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await bucket.put("file:1", { content: bucket.binary(bytes) });
  assert.equal((await bucket.list())[0].updatedAt, before);
});

test("raw binary inputs must use bucket.binary", async () => {
  const bucket = makeBucket(null);
  await assert.rejects(() => bucket.put("file:1", { content: new Uint8Array([1]) }), /bucket\.binary/);
});

test("encoded object payload size cap is object-level", async () => {
  const bucket = makeBucket(null);
  await bucket.put("file:ok", {
    a: bucket.binary(new Uint8Array(40 * 1024 * 1024)),
    b: bucket.binary(new Uint8Array(40 * 1024 * 1024)),
  });
  await assert.rejects(
    () =>
      bucket.put("file:too-large", {
        a: bucket.binary(new Uint8Array(60 * 1024 * 1024)),
        b: bucket.binary(new Uint8Array(45 * 1024 * 1024)),
      }),
    /encoded object payload exceeds/
  );
});

// ---- put/update semantics -------------------------------------------------

test("put deletes locally known omitted fields", async () => {
  const bucket = makeBucket(null);
  await bucket.put("doc", { a: 1, b: 2 });
  await bucket.put("doc", { a: 10 });
  assert.deepEqual(await bucket.get("doc"), { a: 10 });
});

test("put does not delete fields it has never seen (remote-added fields survive)", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  const b = makeBucket(relay);
  await a.put("doc", { title: "v1" });
  await a.sync();
  await b.sync();
  await b.update("doc", { extra: "from-b" });
  await b.sync();
  // A has NOT synced yet, so it does not know `extra`; its put must not kill it.
  await a.put("doc", { title: "v2" });
  await a.sync();
  await b.sync();
  assert.deepEqual(await a.get("doc"), { title: "v2", extra: "from-b" });
  assert.deepEqual(await b.get("doc"), { title: "v2", extra: "from-b" });
});

test("update with undefined deletes a field; omitted fields are preserved", async () => {
  const bucket = makeBucket(null);
  await bucket.put("doc", { a: 1, b: 2, c: 3 });
  await bucket.update("doc", { b: undefined });
  assert.deepEqual(await bucket.get("doc"), { a: 1, c: 3 });
});

// ---- delete semantics -------------------------------------------------------

test("delete propagates and a concurrent remote edit does not resurrect", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  const b = makeBucket(relay);
  await a.put("doc", { title: "keep?" });
  await a.sync();
  await b.sync();
  // Concurrent: B edits while A deletes; delete wins until a later write.
  await b.update("doc", { title: "edited on b" });
  await a.delete("doc");
  await a.sync();
  await b.sync();
  await a.sync();
  assert.equal(await a.get("doc"), null);
  assert.equal(await b.get("doc"), null);
  assert.deepEqual(await b.list(), []);
  const withDeleted = await b.list({ includeDeleted: true });
  assert.equal(withDeleted.length, 1);
  assert.equal(withDeleted[0].deleted, true);
});

test("a later put recreates a deleted object", async () => {
  const bucket = makeBucket(null);
  await bucket.put("doc", { a: 1 });
  await bucket.delete("doc");
  assert.equal(await bucket.get("doc"), null);
  await bucket.put("doc", { a: 2 });
  assert.deepEqual(await bucket.get("doc"), { a: 2 });
  assert.equal((await bucket.list()).length, 1);
});

test("unchanged field values keep their LWW state (re-put does not steamroll concurrent edits)", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  const b = makeBucket(relay);
  await a.put("doc", { title: "t1", body: "b1" });
  await a.sync();
  await b.sync();
  // B genuinely edits body and syncs it. A has not pulled that edit yet, then
  // re-puts the whole object with body UNCHANGED; put() must not re-stamp
  // A's stale body field and steamroll B's remote edit.
  await b.update("doc", { body: "b2-real-edit" });
  await b.sync();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await a.put("doc", { title: "t2", body: "b1" });
  await a.sync();
  await b.sync();
  await a.sync();
  assert.deepEqual(await a.get("doc"), { title: "t2", body: "b2-real-edit" });
  assert.deepEqual(await b.get("doc"), { title: "t2", body: "b2-real-edit" });
});

test("a full no-op put does not bump the list entry", async () => {
  const bucket = makeBucket(null);
  await bucket.put("doc", { a: 1 });
  const before = (await bucket.list())[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await bucket.put("doc", { a: 1 });
  assert.equal((await bucket.list())[0].updatedAt, before);
});

test("concurrent updates to the same object do not lose fields", async () => {
  const bucket = makeBucket(null);
  await Promise.all([
    bucket.update("doc", { a: 1 }),
    bucket.update("doc", { b: 2 }),
    bucket.update("doc", { c: 3 }),
  ]);
  assert.deepEqual(await bucket.get("doc"), { a: 1, b: 2, c: 3 });
});

test("createBucket returns the same handle for the same id", async () => {
  const instance = createInstance({ namespace: `same${Date.now()}`, storage: "memory" });
  const first = instance.createBucket({ id: "spec.example.com" });
  const second = instance.createBucket({ id: "spec.example.com" });
  assert.strictEqual(first, second);
});

test("invalid namespaces are rejected", () => {
  assert.throws(() => createInstance({ namespace: "Bad-Name" }));
  assert.throws(() => createInstance({ namespace: "" }));
  assert.throws(() => createInstance({ namespace: "a".repeat(33) }));
});

// ---- reserved namespace -----------------------------------------------------

test("field names and object ids starting with ~ are rejected", async () => {
  const bucket = makeBucket(null);
  await assert.rejects(() => bucket.put("~sneaky", { a: 1 }));
  await assert.rejects(() => bucket.put("doc", { "~deleted": true }));
  await assert.rejects(() => bucket.update("doc", { "~x": 1 }));
});

// ---- relay listing: list + cold start --------------------------------------

function remoteFields(relay, wireId) {
  const entry = relay.objects.get(wireId);
  return entry ? decodePayloadDoc(entry.plaintext).fields : null;
}

test("fresh device discovers objects through the relay listing", async () => {
  const relay = createMockRelay();
  const seed = makeBucket(relay);
  await seed.put("note:1", { body: "one" });
  await seed.put("note:2", { body: "two" });
  await seed.sync();

  const fresh = makeBucket(relay);
  assert.deepEqual(await fresh.list(), [], "nothing local before sync");
  await fresh.sync();
  const rows = await fresh.list({ prefix: "note:" });
  assert.equal(rows.length, 2);
  assert.deepEqual(await fresh.get("note:1"), { body: "one" });
  assert.deepEqual(await fresh.get("note:2"), { body: "two" });
});

test("a no-change sync pass lists heads without pulling objects", async () => {
  const relay = createMockRelay();
  const bucket = makeBucket(relay);
  await bucket.put("note:1", { body: "clean" });
  await bucket.sync();

  const baseTransport = relay.transport();
  const calls = { listHeads: 0, pullHead: 0 };
  bucket.__bindTestTransport({
    ...baseTransport,
    async listHeads() {
      calls.listHeads += 1;
      return baseTransport.listHeads();
    },
    async pullHead(wireId) {
      calls.pullHead += 1;
      return baseTransport.pullHead(wireId);
    },
  });

  await bucket.sync();

  assert.deepEqual(calls, { listHeads: 1, pullHead: 0 });
});

test("sync never pushes the ~index object", async () => {
  const relay = createMockRelay();
  const bucket = makeBucket(relay);
  await bucket.put("note:1", { body: "one" });
  await bucket.update("note:2", { body: "two" });
  await bucket.delete("note:1");
  await bucket.sync();
  assert.deepEqual([...relay.objects.keys()].sort(), ["note:1", "note:2"]);
  assert.equal((await bucket.list({ includeDeleted: true })).length, 2, "local index still backs list()");
});

test("every written object carries ~id, hidden from the app", async () => {
  const relay = createMockRelay();
  const bucket = makeBucket(relay);
  await bucket.update("note:1", { body: "one" });
  await bucket.delete("note:2");
  await bucket.sync();
  assert.equal(remoteFields(relay, "note:1")["~id"].v, "note:1");
  assert.equal(remoteFields(relay, "note:2")["~id"].v, "note:2");
  assert.deepEqual(await bucket.get("note:1"), { body: "one" });
});

test("empty writes to a missing object stay a no-op", async () => {
  const bucket = makeBucket(null);
  await bucket.update("note:1", {});
  await bucket.put("note:2", {});
  assert.deepEqual(await bucket.list(), []);
});

// The test seam binds with identity wire ids (blinding has its own unit
// tests), so app object ids are directly addressable on the mock relay.
test("evicted objects are absent on a fresh device, not an error", async () => {
  const relay = createMockRelay();
  const seed = makeBucket(relay);
  await seed.put("note:1", { body: "one" });
  await seed.sync();
  relay.evict("note:1");

  const fresh = makeBucket(relay);
  await fresh.sync();
  assert.deepEqual(await fresh.list(), []);
  assert.equal(await fresh.get("note:1"), null);
});

test("a remote object whose ~id does not match is not adopted", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  await a.put("note:1", { body: "mine" });
  await a.sync();
  const forged = decodePayloadDoc(relay.objects.get("note:1").plaintext);
  forged.fields["~id"] = { v: "note:other", ts: Date.now() + 1000, actor: "z" };
  forged.fields.body = { v: "forged", ts: Date.now() + 1000, actor: "z" };
  relay.objects.set("note:1", { versionId: crypto.randomUUID(), plaintext: encodePayloadDoc(forged) });

  const details = [];
  a.on("state", (_state, detail) => details.push(detail));
  await a.sync();
  assert.deepEqual(await a.get("note:1"), { body: "mine" }, "known object keeps local state");
  assert.ok(details.some((detail) => /object id mismatch/.test(detail)));

  const fresh = makeBucket(relay);
  await fresh.sync();
  assert.deepEqual(await fresh.list(), [], "unknown object with a foreign ~id is skipped");
});

// ---- 0.9.0 compatibility ----------------------------------------------------

// Writes the way SDK 0.9.0 did: no ~id, and every change also pushes ~index.
function createLegacyDevice(relay) {
  const client = new BucketClient({ transport: relay.transport(), storage: createMemoryStorage(), actorId: "legacy", pushDebounceMs: 60_000 });
  let rev = 0;
  return {
    client,
    async write(objectId, fields) {
      await client.setFields(objectId, fields);
      rev = Math.max(rev + 1, Date.now());
      await client.setFields("~index", { [objectId]: { updatedAt: new Date().toISOString(), rev } });
      await client.flush(objectId);
      await client.flush("~index");
    },
  };
}

test("a bucket written by 0.9.0 is restored and upgraded with ~id", async () => {
  const relay = createMockRelay();
  const legacy = createLegacyDevice(relay);
  await legacy.write("note:1", { body: "old" });
  const legacyIndexVersion = relay.objects.get("~index").versionId;

  const fresh = makeBucket(relay);
  await fresh.sync();
  assert.deepEqual(await fresh.get("note:1"), { body: "old" });
  assert.deepEqual((await fresh.list()).map((row) => row.id), ["note:1"]);
  assert.equal(remoteFields(relay, "note:1")["~id"].v, "note:1", "upgraded in place");
  assert.equal(relay.objects.get("~index").versionId, legacyIndexVersion, "legacy ~index is not pushed");
});

test("an open 0.9.0 device keeps pushing edits and new objects", async () => {
  const relay = createMockRelay();
  const legacy = createLegacyDevice(relay);
  await legacy.write("note:1", { body: "v1" });
  const current = makeBucket(relay);
  await current.sync();

  await legacy.client.syncObject("note:1");
  await legacy.write("note:1", { body: "v2" });
  await legacy.write("note:2", { body: "new" });
  await current.sync();
  assert.deepEqual(await current.get("note:1"), { body: "v2" });
  assert.deepEqual(await current.get("note:2"), { body: "new" }, "resolved through the legacy ~index");
  assert.equal(remoteFields(relay, "note:1")["~id"].v, "note:1", "legacy edits keep ~id");
});

test("~id dropped by a 0.9.0 put() is written back", async () => {
  const relay = createMockRelay();
  const current = makeBucket(relay);
  await current.put("note:1", { body: "one" });
  await current.sync();

  const legacy = createLegacyDevice(relay);
  await legacy.client.syncObject("note:1");
  await legacy.write("note:1", { "~id": undefined, body: "rewritten" });
  assert.equal(remoteFields(relay, "note:1")["~id"], undefined);

  await current.sync();
  assert.deepEqual(await current.get("note:1"), { body: "rewritten" });
  assert.equal(remoteFields(relay, "note:1")["~id"].v, "note:1");
});

// ---- eviction healing -------------------------------------------------------

test("relay loss is healed from local state on next sync", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  await a.put("note:1", { body: "survives" });
  await a.sync();
  for (const wireId of [...relay.objects.keys()]) relay.evict(wireId);
  assert.equal(relay.objects.size, 0);
  await a.sync();
  assert.deepEqual([...relay.objects.keys()], ["note:1"], "object re-created, no ~index");
  const fresh = makeBucket(relay);
  await fresh.sync();
  assert.deepEqual(await fresh.get("note:1"), { body: "survives" });
});

// ---- namespace isolation ----------------------------------------------------

test("same namespace persists across instance re-creation; different namespace is isolated", async () => {
  const ns = `specpersist${Date.now()}`;
  const first = createInstance({ namespace: ns, storage: "memory" }).createBucket({ id: "spec.example.com" });
  await first.put("note:1", { body: "persisted" });

  const again = createInstance({ namespace: ns, storage: "memory" }).createBucket({ id: "spec.example.com" });
  assert.deepEqual(await again.get("note:1"), { body: "persisted" }, "same namespace sees the data");

  const other = createInstance({ namespace: `${ns}other`, storage: "memory" }).createBucket({ id: "spec.example.com" });
  assert.equal(await other.get("note:1"), null, "different namespace sees nothing");
  assert.deepEqual(await other.list(), []);
});

test("createInstance defaults namespace to default", async () => {
  const bucket = createInstance({ storage: "memory" }).createBucket({ id: "spec.example.com" });
  await bucket.put("note:default", { body: "default namespace" });
  const again = createInstance({ namespace: "default", storage: "memory" }).createBucket({ id: "spec.example.com" });
  assert.deepEqual(await again.get("note:default"), { body: "default namespace" });
});

test("namespace validation is intentionally narrow", () => {
  assert.throws(() => createInstance({ namespace: "", storage: "memory" }));
  assert.throws(() => createInstance({ namespace: "notes-dev", storage: "memory" }));
  assert.throws(() => createInstance({ namespace: "Notes", storage: "memory" }));
});

test("bucket id must be explicit", () => {
  const instance = createInstance({ storage: "memory" });
  assert.throws(() => instance.createBucket());
  assert.throws(() => instance.createBucket({ id: "" }));
});

// ---- change events ----------------------------------------------------------

test("on('change') fires for remote-merged changes", async () => {
  const relay = createMockRelay();
  const a = makeBucket(relay);
  const b = makeBucket(relay);
  const changed = [];
  const off = b.on("change", (objectId) => changed.push(objectId));
  await a.put("note:1", { body: "hi" });
  await a.sync();
  await b.sync();
  assert.ok(changed.includes("note:1"), `expected change event for note:1, got ${JSON.stringify(changed)}`);
  off();
});
