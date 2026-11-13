import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteClient } from "../src/remote/client.ts";

const meta = { objectId: "note", versionId: "D", parentVersionIds: ["C"], extra: true };
const head = { versionId: "D", headVersionMeta: meta };
const hint = { objectId: "note", versionId: "D" };
const ready = "event: sync-ready\ndata: {}\n\n";
const change = data => `event: sync-feed\ndata: ${JSON.stringify(data)}\n\n`;
const code = expected => error => error.code === expected;
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values; };
function setup(handler) {
  const calls = [];
  const remote = createRemoteClient({ apiBase: "https://api.example.com", bucketId: "bucket", mfid: "alias",
    getCredential: () => ({ token: "token" }), fetch: async (url, init) => {
      calls.push({ url: new URL(url), ...init });
      return handler(calls.at(-1));
    },
  }).getBucket();
  return { remote, calls };
}
function stream(text, { close = true, bytes = false, contentType = "text/event-stream" } = {}) {
  let controller, cancelled = 0;
  const data = new TextEncoder().encode(text);
  const body = new ReadableStream({ start(value) {
    controller = value;
    for (const chunk of bytes ? [...data].map(byte => new Uint8Array([byte])) : [data]) controller.enqueue(chunk);
    if (close) controller.close();
  }, cancel() { cancelled++; } });
  return { response: new Response(body, { headers: { "content-type": contentType } }), body,
    fail(error) { controller.error(error); }, cancelled: () => cancelled };
}

for (const history of [null, [], ["D", "C", "A"], ["D"]]) {
  test(`current preserves ancestry evidence ${JSON.stringify(history)}`, async () => {
    const value = { ...head, history };
    const { remote, calls } = setup(() => Response.json(value));
    assert.deepEqual(await remote.getCurrent("note", { knownVersionId: history?.length === 1 ? "D" : "A" }), value);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.searchParams.get("have"), history?.length === 1 ? "D" : "A");
    assert.equal(calls[0].url.searchParams.has("knownVersionId"), false);
  });
}
test("normal pulls omit have and nullable have never becomes a version ID", async () => {
  const { remote, calls } = setup(() => Response.json(head));
  for (const knownVersionId of [undefined, null]) assert.deepEqual(await remote.getCurrent("note", { knownVersionId }), head);
  assert.ok(calls.every(call => call.url.search === "?miss=null"));
});
test("missing objects with requested history remain null", async () => {
  const { remote } = setup(() => Response.json({ versionId: null, headVersionMeta: null, history: [] }));
  assert.equal(await remote.getCurrent("missing", { knownVersionId: "old" }), null);
});
for (const history of [undefined, false, ["D", "C"], ["A", "D"], ["D", "D", "A"]]) {
  test(`invalid or absent requested ancestry fails visibly: ${JSON.stringify(history)}`, async () => {
    const { remote } = setup(() => Response.json({ ...head, history }));
    await assert.rejects(remote.getCurrent("note", { knownVersionId: "A" }), code("INVALID_RESPONSE"));
  });
}
test("ancestry has no client-side Worker history limit", async () => {
  const history = ["D", ...Array.from({ length: 300 }, (_, i) => `v${i}`), "A"];
  const { remote } = setup(() => Response.json({ ...head, history }));
  assert.deepEqual((await remote.getCurrent("note", { knownVersionId: "A" })).history, history);
});
test("fixed-anchor history pages preserve metadata and opaque cursors", async () => {
  const cursor = "opaque:+/ with spaces";
  const { remote, calls } = setup(call => Response.json({ ...meta,
    history: call.url.searchParams.has("cursor") ? ["A"] : ["D", "C"],
    nextCursor: call.url.searchParams.has("cursor") ? null : cursor,
  }));
  const first = await remote.listVersions("note", "D", { cursor: null, limit: 300 });
  const last = await remote.listVersions("note", "D", { cursor: first.nextCursor });
  assert.equal(first.extra, true); assert.deepEqual(last.history, ["A"]); assert.equal(last.nextCursor, null);
  assert.equal(calls[0].url.searchParams.get("limit"), "300");
  assert.equal(calls[1].url.searchParams.get("cursor"), cursor);
  assert.ok(calls.every(call => call.url.pathname.endsWith("/versions/D/meta") && call.url.searchParams.get("history") === "full"));
});
for (const [options, history] of [
  [{}, []], [{ cursor: null }, []], [{ cursor: "" }, []],
  [{}, ["C", "D"]], [{}, ["D", "D"]], [{ cursor: "next" }, ["C", "C"]],
]) {
  test(`history rejects invalid page ${JSON.stringify({ options, history })}`, async () => {
    const { remote } = setup(() => Response.json({ ...meta, history, nextCursor: null }));
    await assert.rejects(remote.listVersions("note", "D", options), code("INVALID_RESPONSE"));
  });
}
test("later history pages can end without repeating the anchor", async () => {
  let history = ["A"];
  const { remote } = setup(() => Response.json({ ...meta, history, nextCursor: null }));
  assert.deepEqual((await remote.listVersions("note", "D", { cursor: "next" })).history, ["A"]);
  history = [];
  assert.deepEqual((await remote.listVersions("note", "D", { cursor: "end" })).history, []);
});
test("index null cursor chains into the first feed page without stringification", async () => {
  const index = { bucketId: "bucket", objects: [], feedCursor: null, hasMoreFeed: true, extra: true };
  const { remote, calls } = setup(call => Response.json(call.url.pathname.endsWith("objects:index") ? index
    : { entries: [hint], cursor: "feed:1", hasMore: false, extra: true }));
  const snapshot = await remote.getIndex();
  assert.deepEqual(snapshot, index);
  const page = await remote.listFeed({ cursor: snapshot.feedCursor });
  assert.deepEqual(page.entries, [hint]); assert.equal(page.extra, true);
  assert.equal(calls[1].url.search, "");
  await remote.listFeed({ cursor: page.cursor, limit: 2 });
  assert.equal(calls[2].url.searchParams.get("cursor"), "feed:1");
  assert.equal(calls[2].url.searchParams.get("limit"), "2");
});
test("empty feed cursor can be reused at startup", async () => {
  const { remote, calls } = setup(() => Response.json({ entries: [], cursor: "", hasMore: false }));
  const first = await remote.listFeed();
  assert.deepEqual(await remote.listFeed({ cursor: first.cursor }), first);
  assert.ok(calls.every(call => call.url.search === ""));
});
for (const invoke of [r => r.getIndex(), r => r.listFeed(), r => r.listVersions("note", "D")]) {
  test("discovery rejects malformed responses and preserves retryable indexing failures", async () => {
    let unavailable = false;
    const { remote, calls } = setup(() => unavailable
      ? Response.json({ code: "SYNC_HISTORY_INDEXING", details: { retryable: true } }, { status: 503 })
      : Response.json({}));
    await assert.rejects(invoke(remote), code("INVALID_RESPONSE"));
    unavailable = true;
    await assert.rejects(invoke(remote), error => error.code === "SYNC_HISTORY_INDEXING" && error.retryable && error.status === 503);
    assert.equal(calls.length, 2);
  });
}
test("invalid pagination fails before HTTP without imposing a Worker maximum", async () => {
  const { remote, calls } = setup(() => assert.fail("HTTP should not run"));
  for (const options of [{ cursor: false }, { cursor: 123 }, { limit: NaN }, { limit: 0 }, { limit: 1.5 }]) {
    await assert.rejects(remote.listFeed(options), code("INVALID_INPUT"));
  }
  assert.equal(calls.length, 0);
});
test("watchFeed waits for readiness and exposes only normalized hints", async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const { remote, calls } = setup(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  let opened = false;
  const opening = remote.watchFeed().then(stream => { opened = true; return stream; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(opened, false);
  assert.equal(calls[0].headers.get("accept"), "text/event-stream");
  controller.enqueue(new TextEncoder().encode(ready + 'event: future\ndata: not-json\n\n'
    + change({ ...hint, bucketId: "bucket", changedAt: "now" })
    + change({ entries: [hint, { objectId: "other", versionId: "E" }] })));
  controller.close();
  const iterator = await opening;
  assert.equal(opened, true);
  assert.deepEqual(await collect(iterator), [hint, hint, { objectId: "other", versionId: "E" }]);
  assert.equal(body.locked, false); assert.equal(calls.length, 1);
});
for (const separator of ["\n", "\r", "\r\n"]) {
  test(`stream handles byte-split UTF-8, multiline data and ${JSON.stringify(separator)} lines`, async () => {
    const text = (': comment\nid: ignored\nevent: sync-ready\ndata: {}\n\n'
      + 'event: sync-feed\ndata: {"objectId":"笔记",\ndata: "versionId":"D"}\n\n').replaceAll("\n", separator);
    const source = stream(text, { bytes: true });
    const { remote } = setup(() => source.response);
    assert.deepEqual(await collect(await remote.watchFeed()), [{ objectId: "笔记", versionId: "D" }]);
    assert.equal(source.body.locked, false);
  });
}
for (const text of ["", change(hint), ready + 'event: sync-feed\ndata: broken\n\n', ready + change({ entries: [hint, {}] })]) {
  test("malformed or unready stream fails without reconnecting", async () => {
    const source = stream(text);
    const { remote, calls } = setup(() => source.response);
    await assert.rejects(async () => collect(await remote.watchFeed()), code("INVALID_RESPONSE"));
    assert.equal(calls.length, 1); assert.equal(source.body.locked, false);
  });
}
test("wrong stream content type cancels the unused body", async () => {
  const source = stream("not SSE", { close: false, contentType: "application/json" });
  const { remote } = setup(() => source.response);
  await assert.rejects(remote.watchFeed(), code("INVALID_RESPONSE"));
  assert.equal(source.cancelled(), 1); assert.equal(source.body.locked, false);
});
test("closing an opened stream before iteration cancels and releases its reader", async () => {
  const source = stream(ready, { close: false });
  const { remote, calls } = setup(() => source.response);
  const iterator = await remote.watchFeed();
  await iterator.return();
  assert.equal(source.cancelled(), 1); assert.equal(source.body.locked, false); assert.equal(calls.length, 1);
});
test("abort during a pending read preserves its reason and cancels the reader", async () => {
  const source = stream(ready, { close: false }), controller = new AbortController();
  const { remote } = setup(() => source.response);
  const iterator = await remote.watchFeed({ signal: controller.signal });
  const pending = iterator.next(), reason = new DOMException("Cancelled", "AbortError");
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(source.cancelled(), 1); assert.equal(source.body.locked, false);
});
test("abort while awaiting readiness rejects watchFeed and releases the reader", async () => {
  const source = stream("", { close: false }), controller = new AbortController();
  const { remote } = setup(() => source.response);
  const opening = remote.watchFeed({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const reason = new DOMException("Cancelled opening", "AbortError"); controller.abort(reason);
  await assert.rejects(opening, error => error === reason);
  assert.equal(source.cancelled(), 1); assert.equal(source.body.locked, false);
});
test("EOF after readiness ends a stream without emitting readiness", async () => {
  const source = stream(ready);
  const { remote } = setup(() => source.response);
  assert.deepEqual(await collect(await remote.watchFeed()), []);
  assert.equal(source.body.locked, false);
});
test("stream network errors are retryable without automatic reconnect", async () => {
  const source = stream(ready, { close: false });
  const { remote, calls } = setup(() => source.response);
  const iterator = await remote.watchFeed();
  const pending = iterator.next(), failure = new TypeError("socket reset"); source.fail(failure);
  await assert.rejects(pending, error => error.code === "NETWORK_ERROR" && error.retryable && error.cause === failure);
  assert.equal(calls.length, 1); assert.equal(source.body.locked, false);
});
