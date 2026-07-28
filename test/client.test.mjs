import assert from "node:assert/strict";
import test from "node:test";

import { BucketClient } from "../src/bucket/client.ts";
import { createBucketBinaryValue, isBucketBinaryValue } from "../src/bucket/binary.ts";
import { createMockRelay, createMemoryStorage } from "./helpers.mjs";

function makeClient(relay, actorId, overrides = {}) {
  return new BucketClient({
    transport: relay.transport(),
    storage: createMemoryStorage(),
    actorId,
    pushDebounceMs: 0,
    ...overrides,
  });
}

test("two clients converge on disjoint field writes", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a");
  const b = makeClient(relay, "actor-b");

  await a.setFields("doc:1", { title: "from a" });
  await a.syncObject("doc:1");
  await b.setFields("doc:1", { body: "from b" });
  await b.syncObject("doc:1");
  await a.syncObject("doc:1");

  assert.deepEqual(await a.getFields("doc:1"), { title: "from a", body: "from b" });
  assert.deepEqual(await b.getFields("doc:1"), { title: "from a", body: "from b" });
});

test("concurrent same-field writes settle by LWW on both sides", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a");
  const b = makeClient(relay, "actor-b");

  await a.setFields("doc:1", { title: "first" });
  await a.syncObject("doc:1");
  await b.syncObject("doc:1");

  await a.setFields("doc:1", { title: "a-wins?" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await b.setFields("doc:1", { title: "b-wins?" });
  await a.syncObject("doc:1");
  await b.syncObject("doc:1");
  await a.syncObject("doc:1");

  const fromA = await a.getFields("doc:1");
  const fromB = await b.getFields("doc:1");
  assert.deepEqual(fromA, fromB, "replicas converge");
  assert.equal(fromA.title, "b-wins?", "later write wins");
});

test("binary fields converge through client sync", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a");
  const b = makeClient(relay, "actor-b");

  await a.setFields("file:1", { content: createBucketBinaryValue(new Uint8Array([1, 2, 3])) });
  await a.syncObject("file:1");
  await b.syncObject("file:1");

  const fields = await b.getFields("file:1");
  assert.ok(isBucketBinaryValue(fields.content));
  assert.deepEqual(new Uint8Array(await fields.content.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("field deletion propagates and does not resurrect", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a");
  const b = makeClient(relay, "actor-b");

  await a.setFields("doc:1", { title: "keep", scratch: "remove me" });
  await a.syncObject("doc:1");
  await b.syncObject("doc:1");

  await b.setFields("doc:1", { scratch: undefined });
  await b.syncObject("doc:1");
  await a.syncObject("doc:1");

  assert.deepEqual(await a.getFields("doc:1"), { title: "keep" });
  await a.syncObject("doc:1");
  await b.syncObject("doc:1");
  assert.deepEqual(await b.getFields("doc:1"), { title: "keep" });
});

test("relay eviction is healed by re-push from local state", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a");

  await a.setFields("doc:1", { title: "survives" });
  await a.syncObject("doc:1");
  assert.equal(relay.objects.size, 1);

  relay.evict(Array.from(relay.objects.keys())[0]);
  assert.equal(relay.objects.size, 0);

  await a.syncObject("doc:1");
  assert.equal(relay.objects.size, 1, "local state re-created the evicted object");

  const b = makeClient(relay, "actor-b");
  await b.syncObject("doc:1");
  assert.deepEqual(await b.getFields("doc:1"), { title: "survives" });
});

test("CAS conflict during push resolves through the merge loop", async () => {
  const relay = createMockRelay();
  const base = relay.transport();
  let pushes = 0;
  // Interleave a competing write before the first push attempt lands.
  const racingTransport = {
    pullHead: (id) => base.pullHead(id),
    pullPayload: (id, version) => base.pullPayload(id, version),
    async push(id, plaintext, expected) {
      pushes += 1;
      if (pushes === 1) {
        const competitor = new BucketClient({
          transport: relay.transport(),
          storage: createMemoryStorage(),
          actorId: "actor-z",
          pushDebounceMs: 0,
        });
        await competitor.setFields("doc:1", { rival: true });
        await competitor.syncObject("doc:1");
      }
      return base.push(id, plaintext, expected);
    },
  };
  const a = new BucketClient({ transport: racingTransport, storage: createMemoryStorage(), actorId: "actor-a", pushDebounceMs: 0 });
  await a.setFields("doc:1", { mine: 1 });
  await a.syncObject("doc:1");
  const fields = await a.getFields("doc:1");
  assert.deepEqual(fields, { mine: 1, rival: true }, "both writes survive the conflict");
});

test("opaque merge strategy is honored", async () => {
  const relay = createMockRelay();
  const mergeStrategyFor = () => ({
    kind: "opaque",
    merge: (local, remote) => ({ items: Array.from(new Set([...(local?.items || []), ...(remote?.items || [])])).sort() }),
  });
  const a = makeClient(relay, "actor-a", { mergeStrategyFor });
  const b = makeClient(relay, "actor-b", { mergeStrategyFor });

  await a.setData("bag", { items: ["x"] });
  await a.syncObject("bag");
  await b.setData("bag", { items: ["y"] });
  await b.syncObject("bag");
  await a.syncObject("bag");

  assert.deepEqual(await a.getData("bag"), { items: ["x", "y"] });
  assert.deepEqual(await b.getData("bag"), { items: ["x", "y"] });
});

test("wire ids on the relay are blinded when a mapper is provided", async () => {
  const relay = createMockRelay();
  const a = makeClient(relay, "actor-a", {
    wireObjectId: async (id) => `ob_${Buffer.from(id).toString("hex").padEnd(32, "0").slice(0, 32)}`,
  });
  await a.setFields("note:list", { n1: 1 });
  await a.syncObject("note:list");
  const wireIds = Array.from(relay.objects.keys());
  assert.equal(wireIds.length, 1);
  assert.ok(!wireIds[0].includes("index"), "semantic id does not reach the relay");
});

test("auto sync uses index diff instead of sweeping every known object", async () => {
  const relay = createMockRelay();
  const seed = makeClient(relay, "actor-seed");
  await seed.setFields("~index", { "note:1": { updatedAt: "1" }, "note:2": { updatedAt: "1" } });
  await seed.setFields("note:1", { markdown: "one" });
  await seed.setFields("note:2", { markdown: "two" });
  await seed.syncKnown();

  const a = makeClient(relay, "actor-a");
  await a.syncObject("~index");
  await a.syncObject("note:1");
  await a.syncObject("note:2");
  assert.deepEqual(await a.getFields("note:1"), { markdown: "one" });
  assert.deepEqual(await a.getFields("note:2"), { markdown: "two" });

  const remote = makeClient(relay, "actor-remote");
  await remote.syncObject("~index");
  await remote.syncObject("note:1");
  await remote.syncObject("note:2");
  await remote.setFields("note:1", { markdown: "one updated" });
  await remote.setFields("note:2", { markdown: "two updated but not indexed" });
  await remote.setFields("~index", { "note:1": { updatedAt: "2" }, "note:2": { updatedAt: "1" } });
  await remote.syncKnown();

  await a.syncAuto({ indexObjectId: "~index" });

  assert.deepEqual(await a.getFields("note:1"), { markdown: "one updated" });
  assert.deepEqual(await a.getFields("note:2"), { markdown: "two" });
});

test("unchanged head sync does not pull payload", async () => {
  const relay = createMockRelay();
  const seed = makeClient(relay, "actor-seed");
  await seed.setFields("doc:1", { title: "same" });
  await seed.syncObject("doc:1");

  const base = relay.transport();
  let payloadPulls = 0;
  const client = makeClient(relay, "actor-a", {
    transport: {
      pullHead: (id) => base.pullHead(id),
      async pullPayload(id, version) {
        payloadPulls += 1;
        return base.pullPayload(id, version);
      },
      push: (id, plaintext, expected) => base.push(id, plaintext, expected),
    },
  });

  await client.syncObject("doc:1");
  assert.equal(payloadPulls, 1, "first sync needs payload");
  await client.syncObject("doc:1");
  assert.equal(payloadPulls, 1, "unchanged head skips payload");
});
