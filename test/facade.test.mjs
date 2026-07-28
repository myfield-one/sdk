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
import { createMockRelay } from "./helpers.mjs";

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

// ---- internal index: list + cold start -------------------------------------

test("fresh device discovers objects through the internal index", async () => {
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

test("manual sync uses index diff instead of sweeping every known object", async () => {
  const relay = createMockRelay();
  const bucket = makeBucket(relay);
  await bucket.put("note:1", { body: "clean" });
  await bucket.sync();

  const baseTransport = relay.transport();
  const calls = [];
  bucket.__bindTestTransport({
    ...baseTransport,
    async pullHead(wireId) {
      calls.push(wireId);
      return baseTransport.pullHead(wireId);
    },
  });

  await bucket.sync();

  assert.equal(calls.length, 1, `expected only the internal index head request, got ${calls.length}`);
});

// The test seam binds with identity wire ids (blinding has its own unit
// tests), so app object ids are directly addressable on the mock relay.
test("dangling index entries (evicted objects) read as absent, not as errors", async () => {
  const relay = createMockRelay();
  const seed = makeBucket(relay);
  await seed.put("note:1", { body: "one" });
  await seed.sync();
  relay.evict("note:1"); // evict the note, keep the internal index

  const fresh = makeBucket(relay);
  await fresh.sync();
  const rows = await fresh.list();
  assert.equal(rows.length, 1, "list entry still listed");
  assert.equal(rows[0].id, "note:1");
  assert.equal(await fresh.get("note:1"), null, "missing object reads as absent");
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
  assert.ok(relay.objects.size >= 2, "index and object re-created");
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
