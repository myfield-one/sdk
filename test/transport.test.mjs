import assert from "node:assert/strict";
import test from "node:test";

import { BucketTransport, BucketTransportError } from "../src/bucket/transport.ts";

function createTransport(payloadKey = null) {
  return new BucketTransport({
    apiBase: "https://api.example.test",
    mfid: "mf_test",
    keys: { bucketId: "b1", keyId: "k1", payloadKey, wireObjectId: async (id) => id },
    sessionProvider: { getSession: async () => ({ carrier: "bearer", token: "t" }) },
  });
}

function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requested.push(parsed.pathname + parsed.search);
    const body = routes(parsed);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn(requested).finally(() => {
    globalThis.fetch = original;
  });
}

test("listHeads reads the index snapshot, then the feed tail; later entries win", () =>
  withFetch(
    (url) => {
      if (url.pathname.endsWith("/objects:index")) {
        return { bucketId: "b1", feedCursor: "c1", hasMoreFeed: true, objects: [{ objectId: "ob_a", versionId: "v1" }, { objectId: "ob_b", versionId: "v1" }] };
      }
      const cursor = url.searchParams.get("cursor");
      if (cursor === "c1") return { entries: [{ objectId: "ob_a", versionId: "v2" }], cursor: "c2", hasMore: true };
      return { entries: [{ objectId: "ob_c", versionId: "v1" }, { objectId: "ob_a", versionId: "v3" }], cursor: "c3", hasMore: false };
    },
    async (requested) => {
      const heads = await createTransport().listHeads();
      assert.deepEqual(Object.fromEntries(heads), { ob_a: "v3", ob_b: "v1", ob_c: "v1" });
      assert.deepEqual(requested, [
        "/v1/api/sync/buckets/b1/objects:index",
        "/v1/api/sync/buckets/b1/feed?limit=100&cursor=c1",
        "/v1/api/sync/buckets/b1/feed?limit=100&cursor=c2",
      ]);
    }
  ));

test("listHeads reads the feed from the start when there is no snapshot yet", () =>
  withFetch(
    (url) => {
      if (url.pathname.endsWith("/objects:index")) return { bucketId: "b1", feedCursor: null, hasMoreFeed: true, objects: [] };
      return { entries: [{ objectId: "ob_a", versionId: "v1" }], cursor: "c1", hasMore: false };
    },
    async (requested) => {
      const heads = await createTransport().listHeads();
      assert.deepEqual(Object.fromEntries(heads), { ob_a: "v1" });
      assert.equal(requested[1], "/v1/api/sync/buckets/b1/feed?limit=100");
    }
  ));

test("listHeads stops when the feed cursor stops advancing", () =>
  withFetch(
    (url) => {
      if (url.pathname.endsWith("/objects:index")) return { bucketId: "b1", feedCursor: "c1", hasMoreFeed: true, objects: [] };
      return { entries: [], cursor: "c1", hasMore: true };
    },
    async (requested) => {
      await createTransport().listHeads();
      assert.equal(requested.length, 2);
    }
  ));

test("listHeads surfaces an unavailable index as a retryable error", () =>
  withFetch(
    () => new Response(JSON.stringify({ error: "SYNC_OBJECT_INDEX_UNAVAILABLE" }), { status: 503, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(createTransport().listHeads(), (error) => error instanceof BucketTransportError && error.retryable);
    }
  ));

for (const reason of ["version-mismatch", "conflict"])
test(`legacy upload parses HTTP 200 ${reason} as CAS rejection`, async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  await withFetch(() => ({ ok: false, reason, headVersionId: "remote" }), async () => {
    assert.deepEqual(await createTransport(key).push("ob_note", new Uint8Array([1]), "base"),
      { ok: false, conflict: true, remoteVersionId: "remote" });
  });
});

for (const result of [{}, { ok: "true" }, { ok: false }, { ok: false, reason: "unavailable" }])
test(`legacy upload cannot confirm ${JSON.stringify(result)}`, async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  await withFetch(() => result, async () => {
    await assert.rejects(createTransport(key).push("ob_note", new Uint8Array([1]), null),
      error => error instanceof BucketTransportError && error.retryable);
  });
});

test("legacy upload unauthorized acknowledgement invalidates access without retry", async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  let invalidated = 0;
  const transport = new BucketTransport({
    apiBase: "https://api.example.test",
    mfid: "mf_test",
    keys: { bucketId: "b1", keyId: "k1", payloadKey: key, wireObjectId: async (id) => id },
    sessionProvider: { getSession: async () => ({ carrier: "bearer", token: "t" }), onUnauthorized: async () => { invalidated++; } },
  });
  await withFetch(() => ({ ok: false, reason: "unauthorized" }), async () => {
    await assert.rejects(transport.push("ob_note", new Uint8Array([1]), null),
      error => error instanceof BucketTransportError && !error.retryable && error.status === 401);
  });
  assert.equal(invalidated, 1);
});
