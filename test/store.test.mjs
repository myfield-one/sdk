import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";

import { createIndexedDbStorageAdapter, createMemoryStorageAdapter } from "../src/bucket/store.ts";

for (const [name, make] of [
  ["memory", () => createMemoryStorageAdapter()],
  ["indexeddb", () => createIndexedDbStorageAdapter({ dbName: `test-db-${crypto.randomUUID()}` })],
]) {
  test(`${name} adapter: get/set/remove/keys`, async () => {
    const store = make();
    assert.equal(await store.get("missing"), null);
    await store.set("p:a", { value: 1 });
    await store.set("p:b", { value: 2 });
    await store.set("q:c", { value: 3 });
    assert.deepEqual(await store.get("p:a"), { value: 1 });
    assert.deepEqual((await store.keys("p:")).sort(), ["p:a", "p:b"]);
    await store.remove("p:a");
    assert.equal(await store.get("p:a"), null);
    assert.deepEqual(await store.keys("p:"), ["p:b"]);
    await store.removePrefix("p:");
    await store.removePrefix("p:");
    assert.deepEqual(await store.keys(""), ["q:c"]);
  });
}

for (const [name, make] of [
  ["memory", () => createMemoryStorageAdapter()],
  ["indexeddb", () => createIndexedDbStorageAdapter({ dbName: `atomic-db-${crypto.randomUUID()}` })],
]) {
  test(`${name} atomic insert excludes competing writers and rolls back uncloneable values`, async () => {
    const store = make();
    await assert.rejects(store.insertIfEmpty("key:", [
      { key: "key:first", value: 1 }, { key: "active", value: () => {} },
    ]));
    assert.deepEqual(await store.keys(""), []);
    const results = await Promise.all([1, 2].map(id => store.insertIfEmpty("key:", [
      { key: `key:${id}`, value: id }, { key: "active", value: id },
    ])));
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results[0] ? 1 : 2;
    assert.equal(await store.get("active"), winner);
    assert.deepEqual(await store.keys("key:"), [`key:${winner}`]);
  });
}
