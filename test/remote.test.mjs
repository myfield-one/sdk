import assert from "node:assert/strict";
import test from "node:test";
import { ClientError } from "../src/index.ts";
import { createRemoteClient } from "../src/remote/client.ts";

const bucketFor = options => createRemoteClient(options).getBucket();

const meta = { objectId: "folder/note", versionId: "v1", parentVersionIds: [], extension: { title: "秘密" } };
const options = { apiBase: "https://api.example.com", bucketId: "bucket", mfid: "alias" };
const json = (value, init) => Response.json(value, init);
const errorCode = code => error => error instanceof ClientError && error.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function setup(handler) {
  const calls = [];
  let credentials = 0;
  const remote = bucketFor({ ...options,
    getCredential: () => ({ token: `token-${++credentials}` }),
    fetch: async (url, init) => {
      const call = { url: new URL(url), ...init, headers: new Headers(init.headers) };
      calls.push(call);
      return handler(call);
    },
  });
  return { remote, calls, credentialCount: () => credentials };
}

test("construction is lazy and requests use bearer credentials and encoded IDs", async () => {
  const result = { versionId: "v1", headVersionMeta: meta, extra: true };
  const { remote, calls, credentialCount } = setup(call => json(call.url.pathname.endsWith("/meta") ? meta : result));
  assert.equal(calls.length, 0); assert.equal(credentialCount(), 0);
  assert.deepEqual(await remote.getCurrent(meta.objectId), result);
  assert.deepEqual(await remote.getVersionMeta(meta.objectId, "v1"), meta);
  assert.equal(credentialCount(), 2);
  assert.equal(calls[0].url.pathname, "/v1/api/sync/buckets/bucket/objects/folder%2Fnote/current");
  assert.equal(calls[0].url.search, "?miss=null");
  assert.equal(calls[0].headers.get("authorization"), "Bearer token-1");
  assert.equal(calls[0].headers.get("x-myfield-mfid"), "alias");
  assert.equal(calls[0].credentials, "omit");
  assert.equal(calls[1].headers.get("authorization"), "Bearer token-2");
});

test("missing current is null and fixed-version 404 remains an error", async () => {
  const { remote } = setup(call => call.url.pathname.endsWith("/current")
    ? json({ versionId: null, headVersionMeta: null, history: [] })
    : json({ code: "SYNC_VERSION_NOT_FOUND", message: "Missing" }, { status: 404 }));
  assert.equal(await remote.getCurrent("missing"), null);
  await assert.rejects(remote.getVersionMeta("missing", "v1"), errorCode("SYNC_VERSION_NOT_FOUND"));
  await assert.rejects(remote.getPayload("missing", "v1"), error => error.status === 404);
});

test("version reads preserve metadata extensions and return the native streaming Response", async () => {
  const response = new Response(new Uint8Array([0, 255, 42]));
  const { remote } = setup(call => call.url.pathname.endsWith("/meta") ? json(meta) : response);
  assert.deepEqual(await remote.getVersionMeta(meta.objectId, "v1"), meta);
  const result = await remote.getVersion(meta.objectId, "v1");
  assert.deepEqual(result.meta, meta); assert.equal(result.payload, response);
  assert.deepEqual(new Uint8Array(await result.payload.arrayBuffer()), new Uint8Array([0, 255, 42]));
});

test("getVersion starts both reads in parallel", async () => {
  const gate = deferred(), entered = deferred();
  let requests = 0;
  const { remote } = setup(async call => {
    if (++requests === 2) entered.resolve();
    await gate.promise;
    return call.url.pathname.endsWith("/meta") ? json(meta) : new Response("opaque");
  });
  const reading = remote.getVersion(meta.objectId, "v1");
  await entered.promise; gate.resolve();
  assert.equal(await (await reading).payload.text(), "opaque");
});

for (const late of [false, true]) test(`getVersion cancels ${late ? "late" : "available"} payload on metadata failure`, async () => {
  const gate = deferred(); let cancelled = 0;
  const payload = new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const { remote } = setup(async call => {
    if (call.url.pathname.endsWith("/payload")) { if (late) await gate.promise; return payload; }
    if (!late) await new Promise(resolve => setTimeout(resolve, 0));
    return json({ ...meta, versionId: "wrong" });
  });
  await assert.rejects(remote.getVersion(meta.objectId, "v1"), errorCode("INVALID_RESPONSE"));
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, 1);
});

test("payload failure rejects getVersion while later metadata rejection remains handled", async () => {
  const gate = deferred();
  const { remote } = setup(async call => {
    if (call.url.pathname.endsWith("/meta")) { await gate.promise; return json({ wrong: true }); }
    throw new TypeError("connection reset");
  });
  await assert.rejects(remote.getVersion(meta.objectId, "v1"), errorCode("NETWORK_ERROR"));
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
});

test("client snapshots scope/fetch/provider without retargeting after options mutation", async () => {
  const calls = [];
  const input = { ...options, getCredential: () => ({ token: "original" }), fetch: async (url, init) => {
    calls.push({ url, init }); return json({ versionId: null, headVersionMeta: null });
  } };
  const remote = bucketFor(input);
  Object.assign(input, { mfid: "other", bucketId: "other", apiBase: "https://other.example.com", getCredential: () => ({ token: "other" }), fetch: () => assert.fail() });
  await remote.getCurrent("note");
  assert.ok(calls[0].url.startsWith(options.apiBase));
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer original");
  assert.equal(new Headers(calls[0].init.headers).get("x-myfield-mfid"), "alias");
});

for (const payload of [new Uint8Array([0, 255]), new Blob(["encrypted"]), new Uint8Array()]) {
  test(`commit forwards ${payload.constructor.name} (${payload.size ?? payload.byteLength} bytes) unchanged`, async () => {
    const { remote, calls } = setup(() => json({ ok: true }));
    assert.deepEqual(await remote.commit({ meta, payload, expectedHeadVersionId: null }), { ok: true });
    assert.equal(calls[0].body, payload);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("content-type"), "application/octet-stream");
    assert.equal(calls[0].headers.has("x-myfield-expected-head-version-id"), false);
    assert.deepEqual(JSON.parse(Buffer.from(calls[0].headers.get("x-myfield-version-meta"), "base64url").toString("utf8")), meta);
  });
}

for (const result of [{ ok: true }, { ok: false, reason: "version-mismatch" }, { ok: false, reason: "conflict" }]) {
  test(`commit returns ${JSON.stringify(result)} without retry`, async () => {
    const { remote, calls } = setup(() => json(result));
    assert.deepEqual(await remote.commit({ meta: { ...meta, parentVersionIds: ["base"] }, payload: new Uint8Array([42]), expectedHeadVersionId: "base" }), result);
    assert.equal(calls[0].headers.get("x-myfield-expected-head-version-id"), "base");
    assert.equal(calls.length, 1);
  });
}

for (const body of [{}, { ok: "true" }, { ok: false }, { ok: false, reason: "unavailable" }, { ok: false, reason: "future-result" }]) {
  test(`unrecognized write acknowledgement fails closed: ${JSON.stringify(body)}`, async () => {
    const { remote, calls } = setup(() => json(body));
    await assert.rejects(remote.commit({ meta, payload: new Uint8Array([42]), expectedHeadVersionId: null }), errorCode("INVALID_RESPONSE"));
    assert.equal(calls.length, 1);
  });
}

test("413 and 429 preserve limits, retry hints and request IDs", async () => {
  const { remote } = setup(call => call.method === "POST"
    ? json({ code: "SYNC_OBJECT_PAYLOAD_TOO_LARGE", message: "Too large", requestId: "body-id", details: { maxBytes: 16 } }, { status: 413 })
    : json({ code: "RATE_LIMITED", error: "Slow down" }, { status: 429, headers: { "retry-after": "2", "x-request-id": "header-id" } }));
  await assert.rejects(remote.commit({ meta, payload: new Uint8Array([42]), expectedHeadVersionId: null }), error => {
    assert.equal(error.maxBytes, 16); assert.equal(error.status, 413);
    assert.equal(error.requestId, "body-id"); assert.equal(error.retryable, false);
    return error.code === "SYNC_OBJECT_PAYLOAD_TOO_LARGE";
  });
  await assert.rejects(remote.getCurrent("note"), error => {
    assert.equal(error.requestId, "header-id"); assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.retryable, true); return error.code === "RATE_LIMITED";
  });
});

for (const status of [400, 401, 403, 408, 500, 503]) test(`HTTP ${status} is thrown without retries or credential refresh`, async () => {
  const { remote, calls, credentialCount } = setup(() => new Response("non-JSON error", { status }));
  await assert.rejects(remote.getCurrent("note"), error => {
    assert.equal(error.status, status); assert.equal(error.retryable, status === 408 || status >= 500);
    return error.code === "HTTP_ERROR";
  });
  assert.equal(calls.length, 1); assert.equal(credentialCount(), 1);
});

test("Retry-After dates and explicit server retryability are respected", async () => {
  const original = Date.now;
  Date.now = () => Date.parse("2026-01-01T00:00:00Z");
  try {
    const { remote } = setup(() => json({ details: { retryable: false } }, { status: 503, headers: { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" } }));
    await assert.rejects(remote.getCurrent("note"), error => error.retryAfterMs === 3000 && error.retryable === false);
  } finally { Date.now = original; }
});

test("invalid JSON and malformed heads/meta cannot look like missing objects", async () => {
  const bodies = ["{", "[]", "null", "{}", JSON.stringify({ versionId: null, headVersionMeta: meta }),
    JSON.stringify({ versionId: "v1", headVersionMeta: { ...meta, objectId: "other" } })];
  for (const body of bodies) {
    const { remote } = setup(() => new Response(body));
    await assert.rejects(remote.getCurrent(meta.objectId), errorCode("INVALID_RESPONSE"));
  }
  const { remote } = setup(() => json({ ...meta, parentVersionIds: [null] }));
  await assert.rejects(remote.getVersionMeta(meta.objectId, "v1"), errorCode("INVALID_RESPONSE"));
});

test("network and interrupted JSON body failures retain causes", async () => {
  const cause = new TypeError("connection reset");
  for (const handler of [() => { throw cause; }, () => new Response(new ReadableStream({ start(controller) { controller.error(cause); } }))]) {
    const { remote, calls } = setup(handler);
    await assert.rejects(remote.getCurrent("note"), error => error.code === "NETWORK_ERROR" && error.retryable && error.cause === cause);
    assert.equal(calls.length, 1);
  }
});

test("credential provider errors remain application-owned and never send a request", async () => {
  const cause = new Error("authorization unavailable");
  const remote = bucketFor({ ...options, getCredential: async () => { throw cause; }, fetch: () => assert.fail() });
  await assert.rejects(remote.getCurrent("note"), error => error === cause);
});

test("cancellation during JSON body consumption preserves the abort reason", async () => {
  const controller = new AbortController(), entered = deferred();
  const reason = new Error("cancel body");
  const { remote } = setup(call => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"versionId":'));
      call.signal.addEventListener("abort", () => stream.error(call.signal.reason), { once: true });
      entered.resolve();
    },
  })));
  const reading = remote.getCurrent("note", { signal: controller.signal });
  await entered.promise; controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
});

test("cancellation is checked before/after credentials and passed to fetch/body reads", async () => {
  const cancelled = new AbortController(), reason = new Error("cancelled"); cancelled.abort(reason);
  const { remote, calls, credentialCount } = setup(() => assert.fail());
  await assert.rejects(remote.getCurrent("note", { signal: cancelled.signal }), error => error === reason);
  assert.equal(credentialCount(), 0); assert.equal(calls.length, 0);
  const signal = new AbortController(), gate = deferred();
  const client = bucketFor({ ...options, getCredential: () => gate.promise, fetch: () => assert.fail() });
  const waiting = client.getCurrent("note", { signal: signal.signal }); signal.abort(reason); gate.resolve({ token: "secret" });
  await assert.rejects(waiting, error => error === reason);
  const active = new AbortController();
  const fixture = setup(call => {
    assert.equal(call.signal, active.signal);
    return new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
  });
  const request = fixture.remote.getCurrent("note", { signal: active.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); active.abort(reason);
  await assert.rejects(request, error => error === reason);
});

test("invalid JS inputs fail locally instead of sending undefined or dot paths", async () => {
  const { remote, calls } = setup(() => assert.fail());
  for (const id of [undefined, null, 123, "", " ", ".", ".."]) {
    await assert.rejects(remote.getCurrent(id), errorCode("INVALID_INPUT"));
    await assert.rejects(remote.getPayload("note", id), errorCode("INVALID_INPUT"));
  }
  for (const expected of [undefined, 123, "", " ", "bad\nheader"]) {
    await assert.rejects(remote.commit({ meta, payload: new Uint8Array([42]), expectedHeadVersionId: expected }), errorCode("INVALID_INPUT"));
  }
  for (const value of [null, undefined, {}, { meta }, { meta, payload: new ArrayBuffer(1), expectedHeadVersionId: null },
    { meta: { ...meta, objectId: "a..b" }, payload: new Uint8Array([42]), expectedHeadVersionId: null }]) {
    await assert.rejects(remote.commit(value), errorCode("INVALID_INPUT"));
  }
  assert.equal(calls.length, 0);
});

test("invalid service origins and missing providers are rejected without I/O", () => {
  for (const value of [null, undefined, []]) assert.throws(() => bucketFor(value), errorCode("INVALID_INPUT"));
  for (const apiBase of [undefined, "", "invalid", "file:///tmp", "https://api.example.com/prefix", "https://api.example.com/?query", "https://api.example.com/#hash", "https://user:secret@api.example.com"]) {
    assert.throws(() => bucketFor({ ...options, apiBase, getCredential: () => assert.fail() }), errorCode("INVALID_INPUT"));
  }
  assert.throws(() => bucketFor(options), errorCode("INVALID_INPUT"));
});

test("Remote client caches its bucket and shares the captured request context", async () => {
  const calls = [];
  let token = "first";
  const input = { ...options, getCredential: () => ({ token }), fetch: async (url, init) => {
    calls.push({ url: new URL(url), headers: new Headers(init.headers) });
    return json({ versionId: null, headVersionMeta: null });
  } };
  const client = createRemoteClient(input);
  const bucket = client.getBucket();
  assert.equal(client.getBucket(), bucket);
  assert.equal(calls.length, 0);
  input.bucketId = "other";
  input.mfid = "other";
  input.apiBase = "https://other.example";
  await client.getBucket().getCurrent("first");
  token = "second";
  await client.getBucket().getCurrent("second");
  assert.equal(calls[0].url.origin, options.apiBase);
  assert.match(calls[1].url.pathname, /buckets\/bucket\/objects\/second\/current$/);
  assert.equal(calls[1].headers.get("x-myfield-mfid"), options.mfid);
  assert.equal(calls[0].headers.get("authorization"), "Bearer first");
  assert.equal(calls[1].headers.get("authorization"), "Bearer second");
});
