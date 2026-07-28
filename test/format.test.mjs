import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLwwMapUpdates,
  decodePayloadDoc,
  emptyLwwMapDoc,
  encodePayloadDoc,
  lwwMapDocsEqual,
  lwwMapValues,
  LwwClock,
  mergeLwwMapDocs,
  PAYLOAD_FORMAT_VERSION,
} from "../src/bucket/format.ts";
import { canonicalizeFieldMap, createBucketBinaryValue, isBucketBinaryValue } from "../src/bucket/binary.ts";

function doc(fields, tombstones = {}) {
  return { t: "lww-map", fields, tombstones };
}

function randomDoc(rng) {
  const names = ["a", "b", "c", "d"];
  const fields = {};
  const tombstones = {};
  for (const name of names) {
    const roll = rng();
    const ts = 1 + Math.floor(rng() * 5);
    const actor = rng() < 0.5 ? "actor-1" : "actor-2";
    if (roll < 0.4) fields[name] = { v: Math.floor(rng() * 100), ts, actor };
    else if (roll < 0.7) tombstones[name] = { ts, actor };
  }
  return doc(fields, tombstones);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("merge is commutative, associative, idempotent", () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i += 1) {
    const a = randomDoc(rng);
    const b = randomDoc(rng);
    const c = randomDoc(rng);
    assert.ok(lwwMapDocsEqual(mergeLwwMapDocs(a, b), mergeLwwMapDocs(b, a)), "commutative");
    assert.ok(
      lwwMapDocsEqual(mergeLwwMapDocs(mergeLwwMapDocs(a, b), c), mergeLwwMapDocs(a, mergeLwwMapDocs(b, c))),
      "associative"
    );
    assert.ok(lwwMapDocsEqual(mergeLwwMapDocs(a, a), mergeLwwMapDocs(a, mergeLwwMapDocs(a, a))), "idempotent");
  }
});

test("higher timestamp wins; actor id breaks ties", () => {
  const merged = mergeLwwMapDocs(
    doc({ x: { v: "old", ts: 1, actor: "z" } }),
    doc({ x: { v: "new", ts: 2, actor: "a" } })
  );
  assert.equal(merged.fields.x.v, "new");
  const tie = mergeLwwMapDocs(
    doc({ x: { v: "from-a", ts: 5, actor: "a" } }),
    doc({ x: { v: "from-b", ts: 5, actor: "b" } })
  );
  assert.equal(tie.fields.x.v, "from-b");
});

test("tombstone beats equal-or-older field entry and loses to newer", () => {
  const deleted = mergeLwwMapDocs(doc({ x: { v: 1, ts: 3, actor: "a" } }), doc({}, { x: { ts: 3, actor: "a" } }));
  assert.ok(!("x" in deleted.fields), "exact tie goes to the tombstone");
  const rewritten = mergeLwwMapDocs(doc({ x: { v: 2, ts: 4, actor: "a" } }), doc({}, { x: { ts: 3, actor: "b" } }));
  assert.equal(rewritten.fields.x.v, 2, "newer write survives an older delete");
});

test("apply/delete/rewrite via updates keeps values consistent", () => {
  const clock = new LwwClock();
  let d = emptyLwwMapDoc();
  d = applyLwwMapUpdates(d, { title: "hello", body: "world" }, clock, "actor-1");
  assert.deepEqual(lwwMapValues(d), { title: "hello", body: "world" });
  d = applyLwwMapUpdates(d, { body: undefined }, clock, "actor-1");
  assert.deepEqual(lwwMapValues(d), { title: "hello" });
  assert.ok(d.tombstones.body, "delete leaves a tombstone");
  d = applyLwwMapUpdates(d, { body: "again" }, clock, "actor-1");
  assert.deepEqual(lwwMapValues(d), { title: "hello", body: "again" });
});

test("clock is monotonic and ratchets on observed timestamps", () => {
  const clock = new LwwClock();
  const first = clock.next();
  clock.observe(first + 10_000);
  const second = clock.next();
  assert.ok(second > first + 10_000, "clock moves past observed remote timestamps");
  assert.ok(clock.next() > second);
});

test("payload roundtrip carries the format version byte", () => {
  const d = applyLwwMapUpdates(emptyLwwMapDoc(), { a: 1 }, new LwwClock(), "actor-1");
  const bytes = encodePayloadDoc(d);
  assert.equal(bytes[0], PAYLOAD_FORMAT_VERSION);
  const decoded = decodePayloadDoc(bytes);
  assert.equal(decoded.t, "lww-map");
  assert.ok(lwwMapDocsEqual(decoded, d));
});

test("unknown format version is rejected", () => {
  const bytes = encodePayloadDoc(emptyLwwMapDoc());
  bytes[0] = 9;
  assert.throws(() => decodePayloadDoc(bytes), /unsupported payload format version/);
});

test("binary field values roundtrip outside the JSON header", async () => {
  const source = createBucketBinaryValue(new Uint8Array([1, 2, 3, 4]), { mimeType: "application/octet-stream", name: "bytes.bin" });
  const d = applyLwwMapUpdates(emptyLwwMapDoc(), await canonicalizeFieldMap({ content: source }), new LwwClock(), "actor-1");
  const bytes = encodePayloadDoc(d);
  assert.equal(bytes[0], PAYLOAD_FORMAT_VERSION);
  assert.equal(new TextDecoder().decode(bytes).includes("AQIDBA"), false, "raw bytes are not base64-embedded in the JSON header");
  const decoded = decodePayloadDoc(bytes);
  const values = lwwMapValues(decoded);
  assert.ok(isBucketBinaryValue(values.content));
  assert.equal(values.content.size, 4);
  assert.equal(values.content.mimeType, "application/octet-stream");
  assert.equal(values.content.name, "bytes.bin");
  assert.deepEqual(new Uint8Array(await values.content.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test("binary values participate in deterministic LWW tie breaking", async () => {
  const first = applyLwwMapUpdates(emptyLwwMapDoc(), await canonicalizeFieldMap({ content: createBucketBinaryValue(new Uint8Array([1])) }), new LwwClock(), "actor-1");
  const second = applyLwwMapUpdates(emptyLwwMapDoc(), await canonicalizeFieldMap({ content: createBucketBinaryValue(new Uint8Array([2])) }), new LwwClock(), "actor-1");
  first.fields.content.ts = 5;
  second.fields.content.ts = 5;
  const merged = mergeLwwMapDocs(first, second);
  const values = lwwMapValues(merged);
  assert.ok(isBucketBinaryValue(values.content));
  assert.deepEqual(new Uint8Array(await values.content.arrayBuffer()), new Uint8Array([2]));
});

test("opaque payload roundtrip", () => {
  const bytes = encodePayloadDoc({ t: "opaque", data: { any: ["shape", 1] } });
  const decoded = decodePayloadDoc(bytes);
  assert.equal(decoded.t, "opaque");
  assert.deepEqual(decoded.data, { any: ["shape", 1] });
});
