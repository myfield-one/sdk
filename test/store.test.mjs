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
  });
}
