import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { instanceTestCleanup } from "../src/facade.ts";
import { createInstance, ClientError } from "../src/index.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { createIndexedDbStorageAdapter } from "../src/bucket/store.ts";
import { decodeAuthRequestFragment, buildApprovedCallback } from "./auth-fixture.mjs";

const stop = instance => instanceTestCleanup.get(instance)?.();
async function grantedApiOrigin(storage, appId, bucketId = appId) {
  const keys = await storage.keys(`instance:${appId}:context:${encodeURIComponent(`urn:myfield:bucket:${bucketId}`)}:`);
  return keys.length === 1 ? new URL((await storage.get(keys[0])).resourceApiUrl).origin : null;
}

const code = expected => error => error instanceof ClientError && error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(done => setImmediate(done));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(done => setTimeout(done, 2));
  }
  throw new Error("Timed out waiting for test fixture");
}
function browser(t, { namespace = "app.example.com", popup = true } = {}) {
  const names = ["window", "fetch", "indexedDB", "IDBKeyRange"];
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  const opened = [], calls = [], listeners = new Set(), instances = [];
  const location = new URL("https://app.example.com/editor?keep=yes#anchor");
  const win = {
    location, screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 800,
    history: { replaceState(_state, _title, url) { win.location = new URL(url); } },
    addEventListener(event, listener) { if (event === "message") listeners.add(listener); },
    removeEventListener(event, listener) { if (event === "message") listeners.delete(listener); },
    open(_url, name) {
      if (!popup) return null;
      const existing = opened.find(handle => handle.name === name && !handle.closed);
      if (existing) return existing;
      const handle = { location: { href: "about:blank" }, closed: false,
        name, close() { this.closed = true; }, focus() {}, document: { title: "", body: {} } };
      opened.push(handle); return handle;
    },
  };
  globalThis.window = win;
  const defaultHandler = call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ credential: {
      carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    } });
    if (call.url.pathname.endsWith("/current")) return Response.json({ versionId: null, headVersionMeta: null });
    if (call.url.pathname.endsWith("/objects:index")) return Response.json({ bucketId: "remote.example.com", objects: [], feedCursor: null, hasMoreFeed: false });
    return Response.json({ ok: true });
  };
  let handler = defaultHandler;
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: new URL(input), ...init, headers: new Headers(init.headers) };
    calls.push(call); return handler(call);
  };
  t.after(() => {
    for (const instance of instances) stop(instance);
    for (let i = 0; i < names.length; i++) {
      if (previous[i]) Object.defineProperty(globalThis, names[i], previous[i]);
      else delete globalThis[names[i]];
    }
  });
  const data = createIndexedDbStorageAdapter({ dbName: `myfield-sdk:${namespace}` });
  const auth = {
    get: key => data.get(`auth:${key}`), set: (key, value) => data.set(`auth:${key}`, value),
    remove: key => data.remove(`auth:${key}`),
    keys: async prefix => (await data.keys(`auth:${prefix}`)).map(key => key.slice(5)),
  };
  return {
    win, data, auth, opened, calls, namespace,
    setHandler(next) { handler = next; },
    resetHandler() { handler = defaultHandler; },
    instance({ autoSync = false } = {}) { const result = createInstance(namespace); result.getBucket().setAutoSync(autoSync); instances.push(result); return result; },
    legacy() { const result = createInstance({ namespace }); instances.push(result); return result; },
    send(callbackUrl, source = opened.at(-1), origin = "https://myfield.one") {
      for (const listener of listeners) listener({ source, origin, data: { type: "myfield.auth.callback", callbackUrl } });
    },
    async approve(options) {
      await until(() => opened.at(-1)?.location.href.includes("authRequest"));
      const handle = opened.at(-1);
      const wire = decodeAuthRequestFragment(handle.location.href);
      const result = await buildApprovedCallback(wire, location.origin + location.pathname, options);
      this.send(result.callbackUrl, handle, new URL(handle.location.href).origin);
      return { ...result, wire };
    },
  };
}

test("initialization is inert, selects same-named bucket and validates namespace boundaries", async t => {
  const env = browser(t);
  let opens = 0;
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => { opens++; return realOpen(...args); };
  const a = env.instance();
  assert.equal(a.getBucket(), a.getBucket());
  assert.equal(a.getBucket(), a.createBucket({ id: env.namespace }));
  const b = createInstance({ namespace: env.namespace });
  t.after(() => stop(b));
  assert.equal(a.remote.getBucket(), a.remote.getBucket());
  await assert.rejects(a.remote.getBucket().getCurrent("note"), code("NOT_AUTHORIZED"));
  await assert.rejects(a.remote.getBucket().getIndex(), code("NOT_AUTHORIZED"));
  await assert.rejects(a.remote.getBucket().listFeed(), code("NOT_AUTHORIZED"));
  await assert.rejects(a.remote.getBucket().listVersions("note", "v1"), code("NOT_AUTHORIZED"));
  await assert.rejects(a.remote.getBucket().watchFeed(), code("NOT_AUTHORIZED"));
  await assert.rejects(a.connect({ authBase: "https://wrong.example/auth/" }), code("INVALID_INPUT"));
  assert.throws(() => a.remote.getBucket("other"), code("INVALID_INPUT"));
  assert.equal(opens, 0); assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
  for (const name of ["default", "file-drive", "a.b", "a".repeat(63)]) stop(createInstance(name));
  for (const name of ["a".repeat(64), "Card.app", "a..b", "a.", ".a", "a.-b", "-a", "a-", " a", "", "a_b"]) {
    assert.throws(() => createInstance(name), code("INVALID_INPUT"));
  }
  assert.equal(createInstance().namespace, "default");
  assert.throws(() => createInstance("notes", { storage: "memory" }), code("INVALID_INPUT"));
  assert.throws(() => createInstance("notes", { authUrl: "https://custom.example/auth/" }), code("INVALID_INPUT"));
  assert.throws(() => createInstance({ namespace: "notes", authUrl: "/auth/" }), code("INVALID_INPUT"));
  assert.equal("dispose" in a, false);
});

test("connect joins authorization, persists the granted context and uses callback remote bucket", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect();
  assert.equal(instance.connect(), first);
  const { wire } = await env.approve({ remoteBucketId: "remote.example.com" });
  await first;
  assert.equal(wire.resource_id, `urn:myfield:bucket:${env.namespace}`);
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  assert.equal(await env.data.get(`meta:${env.namespace}:endpoints`), null);
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth });
  const context = await auth.getContext(env.namespace);
  assert.equal(context.v, 1); assert.equal(context.resourceApiUrl, "https://api.example.test/v1/api/sync");
  assert.equal((await auth.getBucketAccess(env.namespace)).bucketId, "remote.example.com");
  const remote = instance.remote.getBucket();
  assert.equal(await remote.getCurrent("note"), null);
  assert.match(env.calls.at(-1).url.pathname, /buckets\/remote.example.com\/objects\/note\/current$/);
  assert.equal(env.calls.at(-1).headers.get("authorization"), "Bearer token");
  assert.equal((await env.data.keys("data:")).length, 0);
  assert.equal(await env.data.get("meta:actor"), null);
  const count = env.calls.length;
  await instance.connect(); assert.equal(env.calls.length, count); assert.equal(env.opened.length, 1);
  stop(instance);
  const legacy = env.legacy().createBucket({ id: env.namespace });
  assert.equal(await legacy.resume(), "connected");
  assert.equal(env.opened.length, 1);
  legacy.dispose();
});

test("disconnect clears access but preserves identity and data", async t => {
  const env = browser(t), instance = env.instance();
  await env.data.set("data:unrelated:obj:note", { text: "local" });
  const first = instance.connect(); await env.approve(); await first;
  const before = await env.auth.get("instance:app.example.com:active-instance:current");
  const handle = instance.remote.getBucket();
  await instance.disconnect();
  assert.deepEqual(await env.auth.get("instance:app.example.com:active-instance:current"), before);
  assert.deepEqual(await env.data.get("data:unrelated:obj:note"), { text: "local" });
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  assert.equal((await env.auth.keys("instance:app.example.com:session:")).length, 0);
  await assert.rejects(handle.getCurrent("note"), code("NOT_AUTHORIZED"));
  const second = instance.connect(); await until(() => env.opened.length === 2); await env.approve(); await second;
  assert.equal(instance.remote.getBucket(), handle);
});

test("saved access failures retain grants without prompting, and disconnect allows reauthorization", async t => {
  const env = browser(t);
  let instance = env.instance();
  const first = instance.connect(); await env.approve(); await first; stop(instance);
  for (const key of await env.auth.keys("instance:app.example.com:session:")) await env.auth.remove(key);
  instance = env.instance();
  env.setHandler(() => new Response("revoked", { status: 401 }));
  await assert.rejects(instance.resume(), code("NOT_AUTHORIZED"));
  assert.equal(env.opened.length, 1);
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
  stop(instance);
  instance = env.instance();
  await instance.disconnect();
  env.setHandler(call => call.url.pathname.endsWith("instance-challenge")
    ? Response.json({ challengeId: "next", challenge: "next" })
    : Response.json({ credential: { carrier: "bearer", token: "new", expiresAt: new Date(Date.now() + 7200_000).toISOString() } }));
  const again = instance.connect(); await until(() => env.opened.length === 2);
  await env.approve({ apiBase: "https://custom-api.example" }); await again;
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://custom-api.example");
});

test("same-named legacy Bucket and Instance share authorization", async t => {
  const env = browser(t), instance = env.instance();
  const remote = instance.remote.getBucket();
  const local = instance.createBucket({ id: env.namespace });
  assert.equal(local, instance.getBucket());
  assert.equal(remote, instance.remote.getBucket());
  const connecting = instance.connect();
  const localConnecting = local.connect({ autoSync: false });
  await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(await localConnecting, "connected");
  assert.equal(env.opened.length, 1);
  assert.equal(await remote.getCurrent("note"), null);
  await local.disconnect();
  assert.equal(instance.state, "disconnected");
});

test("disconnect cancels popup and late callback, and immediate reconnect is independent", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect(); const failed = assert.rejects(first, error => error.name === "AbortError");
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const handle = env.opened.at(-1);
  const wire = decodeAuthRequestFragment(handle.location.href);
  const { callbackUrl } = await buildApprovedCallback(wire, env.win.location.href);
  await instance.disconnect(); await failed;
  env.send(callbackUrl, handle);
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  const second = instance.connect(); await until(() => env.opened.length === 2);
  await env.approve(); await second;
});

test("disconnect during session request prevents late session and connection publication", async t => {
  const env = browser(t), instance = env.instance(), entered = deferred(), response = deferred();
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "c", challenge: "c" });
    entered.resolve(); return response.promise;
  });
  const connecting = instance.connect(); const failed = assert.rejects(connecting);
  await env.approve(); await entered.promise;
  await instance.disconnect();
  response.resolve(Response.json({ credential: { carrier: "bearer", token: "late", expiresAt: new Date(Date.now() + 7200_000).toISOString() } }));
  await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:session:")).length, 0);
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  await assert.rejects(instance.remote.getBucket().getCurrent("note"), code("NOT_AUTHORIZED"));
});

test("foreign callback sources are ignored; cancellation and invalid callbacks do not save grants", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); const failed = assert.rejects(connecting, code("NOT_AUTHORIZED"));
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(env.opened.at(-1).location.href);
  const { callbackUrl } = await buildApprovedCallback(wire, env.win.location.href);
  env.send("not a callback URL");
  env.send(callbackUrl, {}); await tick();
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  env.send(callbackUrl.replace(/mf_auth_result=[^#]+$/, "mf_auth_result=invalid"));
  await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
});

test("popup-blocked redirect survives page teardown and reload using the same pending identity", async t => {
  const env = browser(t, { popup: false });
  let instance = env.instance();
  const pending = instance.connect(); const stopped = assert.rejects(pending, error => error.name === "AbortError");
  await until(() => typeof env.win.location.href === "string" && env.win.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(env.win.location.href);
  const { callbackUrl } = await buildApprovedCallback(wire, "https://app.example.com/editor?keep=yes");
  stop(instance); await stopped;
  env.win.location = new URL(callbackUrl);
  instance = env.instance();
  await instance.connect();
  assert.equal(env.win.location.searchParams.get("keep"), "yes");
  assert.equal(env.win.location.searchParams.has("mf_request_id"), false);
  assert.equal((await env.auth.keys("instance:app.example.com:pending-auth:")).length, 0);
});

test("callback identity changes cannot overwrite context or active identity", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); const failed = assert.rejects(connecting, code("NOT_AUTHORIZED"));
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(env.opened.at(-1).location.href);
  const { callbackUrl } = await buildApprovedCallback(wire, env.win.location.href);
  await env.auth.set("instance:app.example.com:active-instance:current", { v: 1, instanceId: "inst_" + "a".repeat(32) });
  env.send(callbackUrl);
  await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  assert.equal((await env.auth.get("instance:app.example.com:active-instance:current")).instanceId, "inst_" + "a".repeat(32));
});

test("session failure after approval keeps the grant and resumes after reopening", async t => {
  const env = browser(t); let instance = env.instance();
  env.setHandler(() => new Response("unavailable", { status: 503 }));
  const connecting = instance.connect(); const failed = assert.rejects(connecting, error => error.status === 503 && error.retryable);
  await env.approve(); await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  stop(instance); instance = env.instance();
  env.setHandler(call => call.url.pathname.endsWith("instance-challenge")
    ? Response.json({ challengeId: "next", challenge: "next" })
    : Response.json({ credential: { carrier: "bearer", token: "new", expiresAt: new Date(Date.now() + 7200_000).toISOString() } }));
  await instance.connect();
  assert.equal(env.opened.length, 1);
});

test("first authorization ignores saved endpoints without a grant", async t => {
  const env = browser(t), instance = env.instance();
  await env.data.set(`meta:${env.namespace}:endpoints`, { authBase: "https://custom.example/auth/", apiBase: "https://old-api.example" });
  await env.data.set("meta:another:endpoints", { authBase: "https://wrong.example/auth/" });
  const connecting = instance.connect();
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  assert.equal(new URL(env.opened.at(-1).location.href).origin, "https://myfield.one");
  await env.approve(); await connecting;
  assert.equal(env.calls[0].url.origin, "https://api.example.test");
  assert.equal((await env.data.get("meta:another:endpoints")).authBase, "https://wrong.example/auth/");
});

test("equivalent forms share old database and legacy namespace trimming remains supported", async t => {
  const env = browser(t);
  const old = createInstance({ namespace: ` ${env.namespace} ` });
  const local = old.createBucket({ id: "other" });
  await local.put("note", { text: "existing" });
  stop(old);
  const fresh = env.instance();
  assert.deepEqual(await fresh.createBucket({ id: "other" }).get("note"), { text: "existing" });
});

test("public root exposes RemoteBucket through Instance, without a construction factory", async () => {
  const api = await import("../src/index.ts");
  assert.equal("createBucketRemote" in api, false);
  assert.equal("createRemoteClient" in api, false);
});

test("disconnect aborts an in-progress Remote payload read with a caller signal", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  env.setHandler(call => new Response(new ReadableStream({
    start(controller) {
      call.signal.addEventListener("abort", () => controller.error(call.signal.reason), { once: true });
    },
  })));
  const response = await instance.remote.getBucket().getPayload("note", "v1", { signal: new AbortController().signal });
  const reading = response.arrayBuffer(); const failed = assert.rejects(reading);
  await instance.disconnect(); await failed;
});

test("disconnect waits for an already-started callback write and removes its result", async t => {
  const env = browser(t), entered = deferred(), release = deferred();
  const { createInstanceConnection } = await import("../src/remote/connection.ts");
  const auth = { ...env.auth, async set(key, value) {
    if (key.includes(":context:")) { entered.resolve(); await release.promise; }
    await env.auth.set(key, value);
  } };
  const connection = createInstanceConnection({ getAppId: () => env.namespace, data: env.data, auth });
  t.after(() => connection.dispose());
  const connecting = connection.connect(); const failed = assert.rejects(connecting);
  await env.approve(); await entered.promise;
  const disconnecting = connection.disconnect();
  release.resolve(); await disconnecting; await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  assert.equal(await env.data.get(`meta:${env.namespace}:endpoints`), null);
});

test("disconnect leaves other buckets and other app identity records intact", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  const unrelated = {
    "instance:app.example.com:context:other:inst": { resourceId: "urn:myfield:bucket:other", instanceId: "inst" },
    "instance:app.example.com:session:other:inst": { resourceId: "urn:myfield:bucket:other" },
    "instance:other.example:context:app:inst": { resourceId: `urn:myfield:bucket:${env.namespace}` },
  };
  for (const [key, value] of Object.entries(unrelated)) await env.auth.set(key, value);
  await instance.disconnect();
  for (const [key, value] of Object.entries(unrelated)) assert.deepEqual(await env.auth.get(key), value);
});

test("legacy inferred endpoints are accepted without being rewritten on restore", async t => {
  const env = browser(t); let instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting; stop(instance);
  const endpoints = { authBase: "https://custom.example/auth/", apiBase: "https://api.custom.example" };
  await env.data.set(`meta:${env.namespace}:endpoints`, endpoints);
  instance = env.instance(); await instance.connect();
  assert.deepEqual(await env.data.get(`meta:${env.namespace}:endpoints`), endpoints);
  assert.equal(env.opened.length, 1);
});

test("concurrent disconnect calls share cleanup before a new connection", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect(); await env.approve(); await first;
  const stopping = instance.disconnect();
  assert.equal(instance.disconnect(), stopping);
  const next = instance.connect();
  await stopping;
  await until(() => env.opened.length === 2);
  await env.approve(); await next;
  assert.equal(await instance.remote.getBucket().getCurrent("note"), null);
});

test("memory storage cannot start redirect authorization", async t => {
  const env = browser(t, { popup: false });
  const instance = createInstance({ namespace: "memory.example", storage: "memory" });
  t.after(() => stop(instance));
  await assert.rejects(instance.connect(), code("INVALID_STATE"));
  assert.equal(env.win.location.href.includes("authRequest"), false);
});

test("resume without access returns disconnected without identity creation or prompting", async t => {
  const env = browser(t), instance = env.instance();
  assert.equal(instance.state, "disconnected");
  assert.equal(await instance.resume(), "disconnected");
  assert.equal(env.opened.length, 0); assert.equal(env.calls.length, 0);
  assert.equal((await env.auth.keys("instance:")).length, 0);
});

test("user connect follows resume and reports isolated state events", async t => {
  const env = browser(t), instance = env.instance(), events = [];
  const unsubscribe = instance.on("state", (state, error) => events.push([state, error?.code]));
  instance.on("state", () => { throw new Error("Application listener failure"); });
  const resuming = instance.resume();
  const connecting = instance.connect();
  assert.equal(await resuming, "disconnected");
  await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(instance.state, "connected");
  const count = env.calls.length;
  assert.equal(await instance.resume(), "connected");
  assert.equal(await instance.connect(), "connected");
  assert.equal(env.calls.length, count);
  await instance.disconnect();
  assert.deepEqual(events, [["connecting", undefined], ["connected", undefined], ["disconnected", undefined]]);
  unsubscribe();
  assert.equal(await instance.resume(), "disconnected");
  assert.equal(events.length, 3);
});

for (const result of ["denied", "invalid"]) test(`own ${result} address callback is cleaned and does not poison later resume`, async t => {
  const env = browser(t), instance = env.instance();
  let target;
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth,
    origin: env.win.location.origin, redirectUri: env.win.location.href,
    authPageUrl: "https://myfield.one/auth/", openAuthUrl: url => { target = url; } });
  await auth.authorize({ bucketId: env.namespace });
  const wire = decodeAuthRequestFragment(target);
  const url = new URL(env.win.location.href);
  url.searchParams.set("mf_request_id", wire.mf_request_id);
  url.searchParams.set("state", wire.state);
  url.searchParams.set("mf_result", result === "denied" ? "denied" : "approved");
  if (result === "invalid") url.hash = "mf_auth_result=bad&keepHash=yes";
  env.win.location = url;
  await assert.rejects(instance.resume(), code("NOT_AUTHORIZED"));
  assert.equal(env.win.location.searchParams.get("keep"), "yes");
  assert.equal(env.win.location.searchParams.has("mf_request_id"), false);
  assert.equal(new URLSearchParams(env.win.location.hash.slice(1)).has("mf_auth_result"), false);
  if (result === "invalid") assert.equal(new URLSearchParams(env.win.location.hash.slice(1)).get("keepHash"), "yes");
  else assert.equal(env.win.location.hash, "#anchor");
  assert.equal(await instance.resume(), "disconnected");
  assert.equal(env.opened.length, 0);
});

for (const saved of [false, true]) test(`foreign bucket callback stays untouched with saved access=${saved}`, async t => {
  const env = browser(t); let instance = env.instance();
  if (saved) { const connecting = instance.connect(); await env.approve(); await connecting; stop(instance); instance = env.instance(); }
  let target;
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth,
    origin: env.win.location.origin, redirectUri: env.win.location.href,
    authPageUrl: "https://myfield.one/auth/", openAuthUrl: url => { target = url; } });
  await auth.authorize({ bucketId: "other.example" });
  const wire = decodeAuthRequestFragment(target);
  const { callbackUrl } = await buildApprovedCallback(wire, env.win.location.href);
  env.win.location = new URL(callbackUrl);
  assert.equal(await instance.resume(), saved ? "connected" : "disconnected");
  assert.equal(env.win.location.href, callbackUrl);
  assert.equal(await auth.getContext("other.example"), null);
  assert.ok(await env.auth.get(`instance:app.example.com:callback-pointer:${wire.mf_request_id}`));
  assert.equal(env.opened.length, saved ? 1 : 0);
});

test("missing resourceApiUrl rejects without consulting saved apiBase or sending requests", async t => {
  const env = browser(t); let instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting; stop(instance);
  for (const key of await env.auth.keys("instance:app.example.com:context:")) {
    const context = await env.auth.get(key); delete context.resourceApiUrl; await env.auth.set(key, context);
  }
  await env.data.set(`meta:${env.namespace}:endpoints`, { authBase: "https://myfield.one/auth/", apiBase: "https://must-not-use.example" });
  instance = env.instance(); const count = env.calls.length;
  await assert.rejects(instance.resume(), code("NOT_AUTHORIZED"));
  assert.equal(env.calls.length, count);
  assert.equal(env.opened.length, 1);
  assert.equal(instance.state, "disconnected");
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
});

for (const [status, errorCode] of [[401, "TOKEN_REVOKED"], [403, "GRANT_REVOKED"], [403, "GRANT_NOT_FOUND"], [403, "AUTH_FAILED"]])
test(`remote ${status} ${errorCode} invalidates session/state; connect can reauthorize`, async t => {
  const env = browser(t), instance = env.instance(), events = [];
  instance.on("state", (state, error) => events.push([state, error?.code]));
  const connecting = instance.connect(); await env.approve(); await connecting;
  const grantKeys = await env.auth.keys("instance:app.example.com:context:");
  const before = await env.auth.get(grantKeys[0]);
  env.setHandler(() => Response.json({ code: errorCode }, { status }));
  const count = env.calls.length;
  await assert.rejects(instance.remote.getBucket().getCurrent("note"), error => error.code === "NOT_AUTHORIZED" && error.status === status);
  assert.equal(env.calls.length, count + 1);
  assert.equal(env.opened.length, 1);
  assert.equal(instance.state, "disconnected");
  assert.equal((await env.auth.keys("instance:app.example.com:session:")).length, 0);
  assert.deepEqual(await env.auth.get(grantKeys[0]), before);
  assert.deepEqual(events.at(-1), ["disconnected", "NOT_AUTHORIZED"]);
  const reconnecting = instance.connect();
  await until(() => env.opened.length === 2 && env.opened.at(-1).location.href.includes("authRequest"));
  env.resetHandler(); await env.approve();
  assert.equal(await reconnecting, "connected");
});

test("saved-access network failures reject without reopening authorization", async t => {
  const env = browser(t); let instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting; stop(instance);
  for (const key of await env.auth.keys("instance:app.example.com:session:")) await env.auth.remove(key);
  instance = env.instance();
  env.setHandler(() => { throw new TypeError("Offline"); });
  await assert.rejects(instance.connect(), error => error.code === "NETWORK_ERROR" && error.retryable);
  assert.equal(env.opened.length, 1);
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
});

test("creating a same-named legacy bucket retains the shared Instance connection", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  const remote = instance.remote.getBucket();
  const local = instance.createBucket({ id: env.namespace });
  assert.equal(local, instance.getBucket());
  assert.equal(instance.state, "connected");
  assert.equal(await remote.getCurrent("note"), null);
  assert.equal(await instance.resume(), "connected");
  assert.equal(await local.resume(), "connected");
  assert.equal(env.opened.length, 1);
  local.dispose();
  assert.equal(await instance.connect({ autoSync: false }), "connected");
});

test("disposing a Local handle does not block key changes after disconnect", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect({ autoSync: false }); await env.approve(); await connecting;
  const key = await instance.getKey();
  instance.getBucket().dispose();
  await assert.rejects(instance.removeKey(), code("INVALID_STATE"));
  await instance.disconnect();
  await instance.removeKey();
  await instance.importKey(key);
  assert.equal((await instance.getKey()).instanceId, key.instanceId);
});

test("legacy-written authorization restores into a separate Instance", async t => {
  const env = browser(t), legacy = env.legacy();
  const local = legacy.createBucket({ id: env.namespace });
  const connecting = local.connect({ autoSync: false });
  await env.approve(); assert.equal(await connecting, "connected"); stop(legacy);
  const instance = env.instance();
  assert.equal(await instance.resume(), "connected");
  assert.equal(env.opened.length, 1);
  assert.equal(await instance.remote.getBucket().getCurrent("note"), null);
});

test("legacy object initializer continues to ignore extra positional arguments", () => {
  const instance = createInstance({ namespace: "extra", storage: "memory" }, { ignored: true });
  assert.equal(instance.namespace, "extra"); stop(instance);
});

test("a rejected address callback cannot block an existing valid grant on later resume", async t => {
  const env = browser(t); let instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting; stop(instance);
  let target;
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth,
    authPageUrl: "https://myfield.one/auth/", origin: env.win.location.origin,
    redirectUri: env.win.location.href, openAuthUrl: url => { target = url; } });
  await auth.authorize({ bucketId: env.namespace });
  const wire = decodeAuthRequestFragment(target);
  const url = new URL(env.win.location.href);
  url.searchParams.set("mf_request_id", wire.mf_request_id);
  url.searchParams.set("state", wire.state);
  url.searchParams.set("mf_result", "denied"); env.win.location = url;
  instance = env.instance();
  await assert.rejects(instance.resume(), code("NOT_AUTHORIZED"));
  assert.equal(await instance.resume(), "connected");
  assert.equal(env.opened.length, 1);
  assert.equal(env.win.location.searchParams.has("mf_request_id"), false);
});

test("disconnect clears pending requests for the shared bucket across flows", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); const cancelled = assert.rejects(connecting, error => error.name === "AbortError");
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const own = decodeAuthRequestFragment(env.opened.at(-1).location.href);
  let target;
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth,
    authPageUrl: "https://myfield.one/auth/", origin: env.win.location.origin,
    redirectUri: env.win.location.href, openAuthUrl: url => { target = url; } });
  await auth.authorize({ bucketId: env.namespace });
  const other = decodeAuthRequestFragment(target);
  const otherPointerKey = `instance:app.example.com:callback-pointer:${other.mf_request_id}`;
  const pointer = await env.auth.get(otherPointerKey);
  await instance.disconnect(); await cancelled;
  assert.equal(await env.auth.get(`instance:app.example.com:callback-pointer:${own.mf_request_id}`), null);
  assert.equal(await env.auth.get(otherPointerKey), null);
  assert.equal(await env.auth.get(pointer.pendingKey), null);
});

test("getting the default Local bucket leaves an active Instance authorization intact", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect();
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const local = instance.createBucket({ id: env.namespace });
  assert.equal(local, instance.getBucket());
  assert.equal(env.opened[0].closed, false);
  const legacyConnect = local.connect({ autoSync: false });
  await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(env.opened.length, 1);
  assert.equal(await legacyConnect, "connected"); local.dispose();
});

test("resume triggered by a disconnected state listener waits for authorization cleanup", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  let resumed;
  instance.on("state", state => { if (state === "disconnected") resumed = instance.resume(); });
  await instance.disconnect();
  assert.equal(await resumed, "disconnected");
  assert.equal(instance.state, "disconnected");
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
  assert.equal(env.opened.length, 1);
});

for (const errorCode of ["GRANT_CAPABILITY_MISMATCH", "INSTANCE_PROOF_INVALID", "OTHER_FORBIDDEN"])
test(`remote 403 ${errorCode} preserves its error and the connected session`, async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  const sessions = await env.auth.keys("instance:app.example.com:session:");
  env.setHandler(() => Response.json({ code: errorCode }, { status: 403 }));
  await assert.rejects(instance.remote.getBucket().getCurrent("note"), error => error.code === errorCode && error.status === 403);
  assert.equal(instance.state, "connected");
  assert.deepEqual(await env.auth.keys("instance:app.example.com:session:"), sessions);
  const count = env.calls.length;
  assert.equal(await instance.connect(), "connected");
  assert.equal(env.calls.length, count); assert.equal(env.opened.length, 1);
});

for (const errorCode of ["GRANT_REVOKED", "GRANT_NOT_FOUND", "AUTH_FAILED"])
test(`session 403 ${errorCode} is NOT_AUTHORIZED on resume and allows explicit authorization`, async t => {
  const env = browser(t); let instance = env.instance();
  const first = instance.connect(); await env.approve(); await first; stop(instance);
  for (const key of await env.auth.keys("instance:app.example.com:session:")) await env.auth.remove(key);
  instance = env.instance();
  env.setHandler(call => call.url.pathname.endsWith("instance-challenge")
    ? Response.json({ challengeId: "challenge", challenge: "value" })
    : Response.json({ code: errorCode }, { status: 403 }));
  await assert.rejects(instance.resume(), error => error.code === "NOT_AUTHORIZED" && error.status === 403);
  assert.equal(instance.state, "disconnected"); assert.equal(env.opened.length, 1);
  const reconnecting = instance.connect();
  await until(() => env.opened.length === 2 && env.opened.at(-1).location.href.includes("authRequest"));
  env.resetHandler(); await env.approve(); assert.equal(await reconnecting, "connected");
});

test("disconnect after redirect/reload clears persisted pending and rejects the late callback", async t => {
  const env = browser(t, { popup: false }); let instance = env.instance();
  const first = instance.connect(); const stopped = assert.rejects(first, error => error.name === "AbortError");
  await until(() => env.win.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(env.win.location.href);
  const { callbackUrl } = await buildApprovedCallback(wire, "https://app.example.com/editor");
  stop(instance); await stopped;
  env.win.location = new URL("https://app.example.com/editor");
  let otherUrl;
  const auth = createInstanceAuthClient({ appId: "app.example.com", storage: env.auth,
    authPageUrl: "https://myfield.one/auth/", origin: env.win.location.origin,
    redirectUri: env.win.location.href, openAuthUrl: url => { otherUrl = url; } });
  await auth.authorize({ bucketId: "other.example" });
  const otherWire = decodeAuthRequestFragment(otherUrl);
  const otherPointerKey = `instance:app.example.com:callback-pointer:${otherWire.mf_request_id}`;
  const otherPointer = await env.auth.get(otherPointerKey);
  instance = env.instance(); await instance.disconnect();
  assert.equal(await env.auth.get(`instance:app.example.com:callback-pointer:${wire.mf_request_id}`), null);
  const pending = await env.auth.keys("instance:app.example.com:pending-auth:");
  assert.deepEqual(pending, [otherPointer.pendingKey]);
  assert.deepEqual(await env.auth.get(otherPointerKey), otherPointer);
  env.win.location = new URL(callbackUrl);
  assert.equal(await instance.resume(), "disconnected");
  assert.equal(await auth.handleCallback(callbackUrl), null);
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 0);
});


test("Instance forwards discovery methods using the authorized remote bucket", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve({ remoteBucketId: "remote.example.com" }); await connecting;
  const remote = instance.remote.getBucket();
  env.setHandler(call => {
    assert.ok(call.url.pathname.startsWith("/v1/api/sync/buckets/remote.example.com/"));
    if (call.url.pathname.endsWith("objects:index")) return Response.json({ bucketId: "remote.example.com", objects: [], feedCursor: null, hasMoreFeed: true });
    if (call.url.pathname.endsWith("/feed")) return Response.json({ entries: [], cursor: "", hasMore: false });
    return Response.json({ objectId: "note", versionId: "v1", parentVersionIds: [], history: ["v1"], nextCursor: null });
  });
  const index = await remote.getIndex();
  assert.equal((await remote.listFeed({ cursor: index.feedCursor })).cursor, "");
  assert.deepEqual((await remote.listVersions("note", "v1")).history, ["v1"]);
});

for (const [status, errorCode] of [[401, "TOKEN_REVOKED"], [403, "GRANT_REVOKED"], [403, "GRANT_CAPABILITY_MISMATCH"]])
test(`stream ${status} ${errorCode} respects Instance authorization classification`, async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  env.setHandler(() => Response.json({ code: errorCode }, { status }));
  const unauthorized = errorCode !== "GRANT_CAPABILITY_MISMATCH";
  await assert.rejects(instance.remote.getBucket().watchFeed(), error => error.code === (unauthorized ? "NOT_AUTHORIZED" : errorCode) && error.status === status);
  assert.equal(instance.state, unauthorized ? "disconnected" : "connected");
  assert.equal(env.opened.length, 1);
});

test("disconnect aborts an active stream without emitting buffered stale hints", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  env.setHandler(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: sync-ready\ndata: {}\n\nevent: sync-feed\ndata: {"objectId":"note","versionId":"v1"}\n\n'));
  } }), { headers: { "content-type": "text/event-stream" } }));
  const stream = await instance.remote.getBucket().watchFeed();
  await instance.disconnect();
  await assert.rejects(stream.next(), error => error.name === "AbortError");
  assert.equal(instance.state, "disconnected");
});

test("a late stream authorization failure cannot invalidate a reconnected Instance", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  const gate = deferred();
  env.setHandler(() => gate.promise);
  const pending = instance.remote.getBucket().watchFeed();
  await until(() => env.calls.at(-1).url.pathname.endsWith("/feed/stream"));
  await instance.disconnect();
  env.resetHandler();
  const reconnecting = instance.connect();
  await until(() => env.opened.length === 2 && env.opened.at(-1).location.href.includes("authRequest"));
  await env.approve(); await reconnecting;
  gate.resolve(Response.json({ code: "GRANT_REVOKED" }, { status: 403 }));
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(instance.state, "connected");
});

for (const confirmed of [true, false])
test(`parsed commit ${confirmed ? "success" : "invalid acknowledgement"} survives a concurrent disconnect`, async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  let disconnected;
  const acknowledgement = Object.defineProperty({}, "ok", { enumerable: true, get() {
    disconnected ??= instance.disconnect();
    return confirmed ? true : undefined;
  } });
  env.setHandler(() => {
    const response = new Response("{}", { headers: { "content-type": "application/json" } });
    response.json = async () => acknowledgement;
    return response;
  });
  const committing = instance.remote.getBucket().commit({
    meta: { objectId: "note", versionId: "v1", parentVersionIds: [] },
    payload: new Uint8Array([42]), expectedHeadVersionId: null,
  });
  try {
    if (confirmed) assert.equal(await committing, acknowledgement);
    else await assert.rejects(committing, code("INVALID_RESPONSE"));
  } finally { await disconnected; }
  assert.equal(instance.state, "disconnected");
});


test("closing an Instance stream before iteration releases the subscription", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: sync-ready\ndata: {}\n\n'));
  }, cancel() { cancelled++; } });
  env.setHandler(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const stream = await instance.remote.getBucket().watchFeed();
  await stream.return();
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
  assert.equal(instance.state, "connected");
});

test("disconnect while awaiting subscription rejects with AbortError", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  let body;
  env.setHandler(call => {
    body = new ReadableStream({ start(controller) {
      call.signal.addEventListener("abort", () => controller.error(call.signal.reason), { once: true });
    } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const opening = instance.remote.getBucket().watchFeed();
  const rejected = assert.rejects(opening, error => error.name === "AbortError");
  await until(() => Boolean(body)); await tick();
  await instance.disconnect(); await rejected;
  assert.equal(body.locked, false); assert.equal(instance.state, "disconnected");
});

for (const mode of ["asyncDispose", "await using"])
test(`${mode} closes an Instance subscription before iteration`, { skip: typeof Symbol.asyncDispose !== "symbol" }, async t => {
  let dispose;
  if (mode === "await using") {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try { dispose = new AsyncFunction("stream", "await using subscription = stream;"); }
    catch { t.skip("Runtime does not support await using syntax"); return; }
  } else dispose = async stream => {
    assert.equal(await stream[Symbol.asyncDispose](), undefined);
    await stream[Symbol.asyncDispose]();
  };
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: sync-ready\ndata: {}\n\n'));
  }, cancel() { cancelled++; } });
  env.setHandler(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const stream = await instance.remote.getBucket().watchFeed();
  try { await dispose(stream); }
  finally { await stream.return(); }
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
  assert.equal(instance.state, "connected");
});

test("appId selects authorization independently from legacy storage scope", async t => {
  const env = browser(t);
  const instance = createInstance({ appId: "notes.example.com", namespace: "default" });
  t.after(() => stop(instance));
  const connecting = instance.connect();
  const { wire } = await env.approve();
  await connecting;
  assert.equal(instance.namespace, "default");
  assert.equal(wire.client_id, "notes.example.com");
  assert.equal(wire.resource_id, "urn:myfield:bucket:notes.example.com");
  const db = createIndexedDbStorageAdapter({ dbName: "myfield-sdk:default" });
  assert.equal((await db.keys("auth:instance:notes.example.com:instance-key:")).length, 1);
  assert.equal((await db.keys("auth:instance:app.example.com:")).length, 0);
  const auth = { keys: async prefix => (await db.keys(`auth:${prefix}`)).map(key => key.slice(5)), get: key => db.get(`auth:${key}`) };
  assert.equal(await grantedApiOrigin(auth, "notes.example.com"), "https://api.example.test");
});

test("no-argument initialization resumes existing hostname identity in the default database", async t => {
  const env = browser(t);
  const data = createIndexedDbStorageAdapter({ dbName: "myfield-sdk:default" });
  const auth = { get: key => data.get(`auth:${key}`), set: (key, value) => data.set(`auth:${key}`, value),
    remove: key => data.remove(`auth:${key}`), keys: async prefix => (await data.keys(`auth:${prefix}`)).map(key => key.slice(5)) };
  let target;
  const original = createInstanceAuthClient({ appId: "app.example.com", storage: auth,
    origin: env.win.location.origin, redirectUri: env.win.location.href,
    authPageUrl: "https://myfield.one/auth/", openAuthUrl: url => { target = url; } });
  await original.authorize({ bucketId: "app.example.com" });
  const wire = decodeAuthRequestFragment(target);
  await original.handleCallback((await buildApprovedCallback(wire, env.win.location.href)).callbackUrl);
  await data.set("meta:app.example.com:endpoints", { authBase: "https://myfield.one/auth/", apiBase: "https://api.example.test" });
  const instance = createInstance(); t.after(() => stop(instance));
  assert.equal(await instance.resume({ autoSync: false }), "connected");
  assert.equal((await original.ensureInstance()).instanceId, wire.mf_instance_id);
  assert.equal((await data.keys("auth:instance:app.example.com:instance-key:")).length, 1);
  assert.equal(env.opened.length, 0);
  assert.equal(await data.get("meta:actor"), null);
});

for (const hostname of ["[::1]", "", "x".repeat(64)]) {
  test(`implicit invalid appId ${hostname || "empty"} is lazy and does not block Local CRUD`, async t => {
    const env = browser(t); env.win.location = { hostname };
    const instance = createInstance({ namespace: "default", storage: "memory" }); t.after(() => stop(instance));
    const bucket = instance.createBucket({ id: "local.example.com" });
    await bucket.put("note", { text: "offline" });
    assert.equal((await bucket.get("note")).text, "offline");
    await assert.rejects(instance.resume(), code("INVALID_INPUT"));
    await assert.rejects(instance.connect(), code("INVALID_INPUT"));
    assert.throws(() => instance.remote.getBucket(), code("INVALID_INPUT"));
    assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
  });
}

test("explicit invalid appId never falls back, and strings mean appId", async t => {
  browser(t);
  for (const value of ["", "UPPER.example", "[::1]", " a.example", null, 12]) {
    assert.throws(() => createInstance({ appId: value }), code("INVALID_INPUT"));
  }
  const instance = createInstance("notes.example.com"); t.after(() => stop(instance));
  assert.equal(instance.namespace, "notes.example.com");
});

test("importKey saves only the supplied identity, rejects repeats and reuses it on authorization", async t => {
  const env = browser(t);
  const { createInstanceKey } = await import("../src/auth/keys.ts");
  const key = await createInstanceKey();
  const instance = env.instance();
  assert.equal(await env.data.get("meta:actor"), null);
  await instance.importKey(key);
  const prefix = "auth:instance:app.example.com:";
  assert.deepEqual((await env.data.keys("")).sort(), [prefix + "active-instance:current", prefix + "instance-key:" + key.instanceId].sort());
  const saved = await env.data.get(prefix + "instance-key:" + key.instanceId);
  assert.equal(saved.signingPrivateKey.extractable, false);
  assert.equal(saved.wrappingPrivateKey.extractable, false);
  await assert.rejects(instance.importKey(key), code("KEY_EXISTS"));
  assert.equal(await instance.resume(), "disconnected");
  assert.equal(env.opened.length, 0); assert.equal(env.calls.length, 0);
  const connecting = instance.connect(); const { wire } = await env.approve(); await connecting;
  assert.equal(wire.mf_instance_id, key.instanceId);
  assert.deepEqual(wire.mf_instance_wrapping_jwk, key.wrappingPublicJwk);
  await assert.rejects(instance.importKey(key), code("INVALID_STATE"));
});

test("importKey is scoped to appId and rejects an orphan instance-key record", async t => {
  const env = browser(t);
  const { createInstanceKey } = await import("../src/auth/keys.ts");
  await env.auth.set("instance:other.example:instance-key:existing", {});
  await env.instance().importKey(await createInstanceKey());
  const second = createInstance({ appId: "second.example", namespace: env.namespace }); t.after(() => stop(second));
  await env.auth.set("instance:second.example:instance-key:orphan", {});
  await assert.rejects(second.importKey(await createInstanceKey()), code("KEY_EXISTS"));
  assert.deepEqual(await env.auth.get("instance:other.example:instance-key:existing"), {});
});

test("concurrent imports on separate Instances cannot both claim the same identity scope", async t => {
  const env = browser(t);
  const { createInstanceKey } = await import("../src/auth/keys.ts");
  const key = await createInstanceKey(), a = env.instance(), b = env.instance();
  const results = await Promise.allSettled([a.importKey(key), b.importKey(key)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(results.find(row => row.status === "rejected").reason.code, "KEY_EXISTS");
  assert.equal((await env.auth.keys("instance:app.example.com:instance-key:")).length, 1);
});

for (const importFirst of [false, true])
test(`importKey rejects when connect ${importFirst ? "starts during validation" : "is already in progress"}`, async t => {
  const env = browser(t);
  const { createInstanceKey } = await import("../src/auth/keys.ts");
  const key = await createInstanceKey(), instance = env.instance();
  const importing = importFirst ? instance.importKey(key) : null;
  const connecting = instance.connect();
  await assert.rejects(importing ?? instance.importKey(key), code("INVALID_STATE"));
  const { wire } = await env.approve();
  await connecting;
  assert.notEqual(wire.mf_instance_id, key.instanceId);
  const rows = await env.auth.keys("instance:app.example.com:instance-key:");
  assert.equal(rows.length, 1); assert.ok(rows[0].endsWith(wire.mf_instance_id));
});

for (const corruption of ["invalid-pointer", "missing-key", "invalid-key", "orphan-key",
  "missing-signing-public-key", "invalid-signing-public-key", "missing-wrapping-public-key", "invalid-wrapping-public-key"])
test(`resume preserves ${corruption} records without creating a replacement identity`, async t => {
  const env = browser(t);
  const { createInstanceKey } = await import("../src/auth/keys.ts");
  const key = await createInstanceKey(), instance = env.instance();
  const prefix = "instance:app.example.com:";
  if (corruption !== "missing-key") {
    const record = { ...key, updatedAt: key.createdAt };
    if (corruption.includes("signing-public-key")) record.signingPublicJwk = corruption.startsWith("missing") ? null : { ...key.signingPublicJwk, crv: "P-384" };
    if (corruption.includes("wrapping-public-key")) record.wrappingPublicJwk = corruption.startsWith("missing") ? null : {};
    await env.auth.set(prefix + "instance-key:" + key.instanceId,
      corruption === "invalid-key" ? {} : record);
  }
  if (corruption !== "orphan-key") {
    await env.auth.set(prefix + "active-instance:current", {
      v: corruption === "invalid-pointer" ? 2 : 1, instanceId: key.instanceId,
    });
  }
  const before = await Promise.all((await env.auth.keys(prefix)).sort().map(async id => [id, await env.auth.get(id)]));
  const failures = [];
  instance.on("state", (state, error) => { if (error) failures.push([state, error.code]); });
  await assert.rejects(instance.getKey(), code("INVALID_INSTANCE_KEY"));
  assert.equal(await instance.resume(), "disconnected");
  assert.deepEqual(failures, [["disconnected", "INVALID_INSTANCE_KEY"]]);
  assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
  await assert.rejects(instance.connect(), code("INVALID_INSTANCE_KEY"));
  await assert.rejects(instance.createKey(), code("KEY_EXISTS"));
  await assert.rejects(instance.importKey(key), code("KEY_EXISTS"));
  const after = await Promise.all((await env.auth.keys(prefix)).sort().map(async id => [id, await env.auth.get(id)]));
  assert.deepEqual(after, before);
  assert.equal(instance.state, "disconnected");
  assert.equal(env.calls.length, 0);
  assert.ok(env.opened.every(popup => popup.closed && !popup.location.href.includes("authRequest")));
  const local = instance.createBucket({ id: "offline.example.com" });
  await local.put("note", { text: "retained" });
  await instance.removeKey();
  assert.equal(await instance.getKey(), null);
  assert.equal((await local.get("note")).text, "retained");
  await instance.importKey(key);
  assert.equal((await instance.getKey()).instanceId, key.instanceId);
});

test("legacy Bucket connect and resume use explicit appId and the selected bucket resource", async t => {
  const env = browser(t);
  const options = { appId: "notes.example.com", namespace: env.namespace };
  const instance = createInstance(options); t.after(() => stop(instance));
  const bucket = instance.createBucket({ id: "archive.example.com" });
  const connecting = bucket.connect({ autoSync: false });
  const { wire } = await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(wire.client_id, options.appId);
  assert.equal(wire.resource_id, "urn:myfield:bucket:archive.example.com");
  const rows = await env.auth.keys("instance:notes.example.com:instance-key:");
  assert.deepEqual(rows, ["instance:notes.example.com:instance-key:" + wire.mf_instance_id]);
  assert.equal((await env.auth.keys("instance:app.example.com:")).length, 0);
  stop(instance);
  const restored = createInstance(options); t.after(() => stop(restored));
  const reopened = restored.createBucket({ id: bucket.id });
  assert.equal(await reopened.resume(), "connected");
  assert.equal(env.opened.length, 1);
  assert.deepEqual(await env.auth.keys("instance:notes.example.com:instance-key:"), rows);
});

test("getKey and createKey preserve nonextractable identity across reload without network", async t => {
  const env = browser(t), instance = env.instance();
  assert.equal(await instance.getKey(), null);
  const key = await instance.createKey();
  assert.equal(key.signingPrivateKey.extractable, false);
  assert.equal(key.wrappingPrivateKey.extractable, false);
  assert.equal("v" in key, false); assert.equal("updatedAt" in key, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", key.signingPrivateKey), { name: "InvalidAccessException" });
  await assert.rejects(instance.createKey(), code("KEY_EXISTS"));
  const snapshot = await instance.getKey();
  snapshot.signingPublicJwk.x = "changed";
  stop(instance);
  const restored = env.instance(), saved = await restored.getKey();
  assert.equal(saved.instanceId, key.instanceId);
  assert.deepEqual(saved.signingPublicJwk, key.signingPublicJwk);
  assert.equal(saved.signingPrivateKey.extractable, false);
  assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
  assert.equal(await env.data.get("meta:actor"), null);
  const connecting = restored.connect(); const { wire } = await env.approve(); await connecting;
  assert.equal(wire.mf_instance_id, key.instanceId);
  assert.equal((await restored.getKey()).instanceId, key.instanceId);
});

test("removeKey clears only this appId's identity and dependent access, retaining Local data", async t => {
  const env = browser(t), instance = env.instance();
  const key = await instance.createKey();
  const local = instance.createBucket({ id: "local.example.com" });
  await local.put("note", { text: "keep" });
  const prefix = "instance:app.example.com:";
  for (const suffix of ["context:old", "session:old", "pending-auth:old", "callback-pointer:old"]) {
    await env.auth.set(prefix + suffix, { v: 1 });
  }
  await env.auth.set("instance:other.example:instance-key:original", { keep: true });
  await env.data.set("meta:app.example.com:endpoints", { authBase: "https://myfield.one/auth/", apiBase: "https://api.example.test" });
  await instance.removeKey(); await instance.removeKey();
  assert.deepEqual(await env.auth.keys(prefix), []);
  assert.equal(await instance.getKey(), null);
  assert.equal((await local.get("note")).text, "keep");
  assert.deepEqual(await env.auth.get("instance:other.example:instance-key:original"), { keep: true });
  assert.equal((await env.data.get("meta:app.example.com:endpoints")).apiBase, "https://api.example.test");
  assert.equal(await instance.resume(), "disconnected");
  await instance.importKey(key);
  assert.equal((await instance.getKey()).instanceId, key.instanceId);
  assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
});

test("key mutations reject during connection and while connected, then allow explicit replacement after disconnect", async t => {
  const env = browser(t), instance = env.instance();
  const key = await instance.createKey();
  const connecting = instance.connect();
  for (const mutate of [() => instance.createKey(), () => instance.importKey(key), () => instance.removeKey()]) {
    await assert.rejects(mutate(), code("INVALID_STATE"));
  }
  await env.approve(); await connecting;
  for (const mutate of [() => instance.createKey(), () => instance.importKey(key), () => instance.removeKey()]) {
    await assert.rejects(mutate(), code("INVALID_STATE"));
  }
  await instance.disconnect();
  await instance.removeKey();
  const next = await instance.createKey();
  assert.notEqual(next.instanceId, key.instanceId);
  assert.equal((await instance.getKey()).instanceId, next.instanceId);
});

test("key mutations cannot replace a legacy Bucket's connected identity", async t => {
  const env = browser(t), instance = env.instance();
  const key = await instance.createKey(), local = instance.createBucket({ id: "local.example.com" });
  const connecting = local.connect({ autoSync: false }); await env.approve(); await connecting;
  assert.equal((await instance.getKey()).instanceId, key.instanceId);
  for (const mutate of [() => instance.createKey(), () => instance.importKey(key), () => instance.removeKey()]) {
    await assert.rejects(mutate(), code("INVALID_STATE"));
  }
  await local.disconnect(); await instance.removeKey();
  assert.equal(await instance.getKey(), null);
});

test("connect waits for an in-progress key removal before choosing an identity", async t => {
  const env = browser(t);
  const { createInstanceConnection } = await import("../src/remote/connection.ts");
  const entered = deferred(), release = deferred();
  const connection = createInstanceConnection({ getAppId: () => env.namespace, data: env.data,
    auth: { ...env.auth, removePrefix: async prefix => {
      entered.resolve(); await release.promise;
      for (const key of await env.auth.keys(prefix)) await env.auth.remove(key);
    } } });
  t.after(() => { release.resolve(); connection.dispose(); });
  const old = await connection.createKey();
  const removing = connection.removeKey(); await entered.promise;
  const connecting = connection.connect();
  await tick(); assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0);
  release.resolve(); await removing;
  const { wire } = await env.approve(); await connecting;
  assert.notEqual(wire.mf_instance_id, old.instanceId);
  assert.equal((await connection.getKey()).instanceId, wire.mf_instance_id);
});

test("autoSync false retains Local CRUD and manual sync without post-write network work", async t => {
  const env = browser(t), instance = env.instance(), local = instance.getBucket();
  const connecting = instance.connect({ autoSync: false }); await env.approve(); await connecting;
  assert.equal(local.state, "connected");
  assert.equal(await env.data.get("meta:actor"), null);
  const before = env.calls.length;
  await local.put("note", { text: "manual" });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(env.calls.length, before);
  assert.equal((await local.get("note")).text, "manual");
  await local.sync();
  assert.ok(env.calls.some(call => call.url.pathname.endsWith("/objects:index")));
  const uploads = env.calls.filter(call => call.method === "POST" && call.body instanceof FormData);
  assert.equal(uploads.length, 1);
  const meta = JSON.parse(uploads[0].body.get("versionMeta"));
  assert.ok(meta.objectId.startsWith("ob_"));
  assert.equal(meta.kind, "create");
  assert.deepEqual(JSON.parse(uploads[0].body.get("headState")).fieldSources, {});
  assert.equal((await local.get("note")).text, "manual");
  await instance.disconnect();
  await assert.rejects(local.sync(), error => error.name === "NotConnectedError");
});

test("default Instance connection starts Local synchronization and reuses the connected session", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true }), local = instance.getBucket();
  await local.put("note", { text: "automatic" });
  const connecting = instance.connect(); await env.approve(); assert.equal(await connecting, "connected");
  await until(() => env.calls.some(call => call.method === "POST" && call.body instanceof FormData));
  await until(() => env.calls.some(call => call.url.pathname.endsWith("/objects:index")));
  const sessions = env.calls.filter(call => call.url.pathname.endsWith("instance-session")).length;
  const heads = env.calls.filter(call => call.url.pathname.endsWith("/current")).length;
  assert.equal(await instance.connect(), "connected");
  assert.equal(env.calls.filter(call => call.url.pathname.endsWith("instance-session")).length, sessions);
  assert.equal(env.calls.filter(call => call.url.pathname.endsWith("/current")).length, heads);
  await local.disconnect();
  assert.equal(instance.state, "disconnected");
  await assert.rejects(instance.remote.getBucket().getCurrent("note"), code("NOT_AUTHORIZED"));
});

test("connect validates saved access with the server while resume can reuse its session", async t => {
  const env = browser(t), first = env.instance();
  const connecting = first.connect({ autoSync: false }); await env.approve(); await connecting; stop(first);
  const sessionCalls = () => env.calls.filter(call => call.url.pathname.endsWith("instance-session")).length;
  const count = sessionCalls(), restored = env.instance();
  assert.equal(await restored.resume({ autoSync: false }), "connected");
  assert.equal(sessionCalls(), count); stop(restored);
  const explicit = env.instance();
  assert.equal(await explicit.connect({ autoSync: false }), "connected");
  assert.equal(sessionCalls(), count + 1);
  await explicit.connect({ autoSync: false });
  assert.equal(sessionCalls(), count + 1);
});

test("disconnecting the default resource leaves another bucket connected", async t => {
  const env = browser(t), instance = env.instance(), other = instance.createBucket({ id: "archive.example.com" });
  const first = instance.connect({ autoSync: false }); await env.approve(); await first;
  const second = other.connect({ autoSync: false });
  await until(() => env.opened.length === 2); const { wire } = await env.approve(); await second;
  assert.equal(wire.resource_id, "urn:myfield:bucket:archive.example.com");
  await instance.disconnect();
  assert.equal(other.state, "connected");
  assert.equal(await other.resume(), "connected");
  await other.disconnect();
});

test("simultaneous bucket authorizations keep their windows and callbacks isolated", async t => {
  const env = browser(t), instance = env.instance(), other = instance.createBucket({ id: "archive.example.com" });
  const first = instance.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  const second = other.connect({ autoSync: false });
  await until(() => env.opened[1]?.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(env.opened[0].location.href);
  const callback = await buildApprovedCallback(wire, env.win.location.href);
  env.send(callback.callbackUrl, env.opened[1]);
  await tick(); assert.equal(instance.state, "connecting");
  env.send(callback.callbackUrl, env.opened[0]);
  assert.equal(await first, "connected");
  assert.equal(other.state, "connecting");
  await env.approve(); assert.equal(await second, "connected");
  await instance.disconnect();
  assert.equal(other.state, "connected");
});

test("shared authorization cancellation rejects Instance callers and resolves legacy callers with state", async t => {
  const env = browser(t), instance = env.instance(), local = instance.getBucket();
  const first = instance.connect({ autoSync: false }), rejected = assert.rejects(first, code("NOT_AUTHORIZED"));
  const second = local.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  env.opened[0].close();
  await rejected;
  assert.equal(await second, "disconnected");
  assert.equal(env.opened.length, 1);
});

test("legacy connect joins Instance authorization", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect({ autoSync: false });
  const second = instance.getBucket().connect({ autoSync: false });
  await env.approve();
  assert.deepEqual(await Promise.all([first, second]), ["connected", "connected"]);
  assert.equal(env.opened.length, 1);
});

test("legacy connect joins saved custom authorization without changing its address", async t => {
  const env = browser(t), original = createInstance({ appId: env.namespace, authUrl: "https://custom.example/auth/" });
  t.after(() => stop(original));
  const first = original.getBucket().connect({ autoSync: false });
  await env.approve(); await first; stop(original);
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  env.setHandler(async call => {
    if (call.url.pathname.endsWith("/current")) return Response.json({ versionId: null, headVersionMeta: null });
    assert.ok(call.url.pathname.endsWith("instance-challenge") || call.url.pathname.endsWith("instance-session"));
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    entered.resolve(); await release.promise;
    return Response.json({ credential: { carrier: "bearer", token: "renewed", expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
  });
  const instance = createInstance({ appId: env.namespace, authUrl: "https://custom.example/auth/" });
  t.after(() => stop(instance));
  await instance.getBucket().ready();
  const restoring = instance.connect({ autoSync: false });
  await entered.promise;
  const joined = instance.getBucket().connect({ autoSync: false });
  await tick();
  release.resolve();
  assert.deepEqual(await Promise.all([restoring, joined]), ["connected", "connected"]);
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  assert.equal(env.opened.length, 1);
});

test("bucket connect rejects a per-call authBase without affecting a pending flow", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  await assert.rejects(instance.getBucket().connect({ authBase: "https://other.example/auth/", autoSync: false }), code("INVALID_INPUT"));
  assert.equal(instance.state, "connecting");
  await env.approve(); assert.equal(await first, "connected");
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  assert.equal(env.opened.length, 1);
});

test("legacy connect waits for startup resume before selecting its authorization page", async t => {
  const env = browser(t), instance = createInstance({ appId: env.namespace, authUrl: "https://custom.example/auth/" });
  t.after(() => stop(instance));
  const local = instance.getBucket();
  const restoring = local.resume();
  const connecting = local.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  assert.equal(new URL(env.opened[0].location.href).origin, "https://custom.example");
  await env.approve();
  assert.deepEqual(await Promise.all([restoring, connecting]), ["disconnected", "connected"]);
  assert.equal(env.opened.length, 1);
});

test("Instance connect waits for startup resume instead of changing its prompt behavior", async t => {
  const env = browser(t), instance = env.instance();
  const restoring = instance.resume({ autoSync: false });
  const first = instance.connect({ autoSync: false });
  const second = instance.connect({ autoSync: false });
  assert.equal(await restoring, "disconnected");
  await env.approve();
  assert.deepEqual(await Promise.all([first, second]), ["connected", "connected"]);
  assert.equal(env.opened.length, 1);
});

test("connect keeps user intent across resume completion microtasks", async t => {
  const env = browser(t);
  const { createInstanceConnection } = await import("../src/remote/connection.ts");
  const { createMemoryStorageAdapter } = await import("../src/bucket/store.ts");
  for (let delay = 0; delay < 15; delay++) {
    const auth = createMemoryStorageAdapter();
    let scheduled = false, connecting, finished = false;
    const connection = createInstanceConnection({ getAppId: () => env.namespace,
      data: createMemoryStorageAdapter(), auth: { ...auth, keys: async prefix => {
        const keys = await auth.keys(prefix);
        if (!scheduled) {
          scheduled = true;
          void (async () => {
            for (let i = 0; i < delay; i++) await Promise.resolve();
            connecting = connection.connect().finally(() => { finished = true; });
          })();
        }
        return keys;
      } } });
    t.after(() => connection.dispose());
    const before = env.opened.length, restoring = connection.resume();
    await until(() => finished || env.opened.length > before && env.opened.at(-1).location.href.includes("authRequest"));
    if (!finished) await env.approve();
    assert.equal(await restoring, "disconnected", `resume at offset ${delay}`);
    assert.equal(await connecting, "connected", `connect at offset ${delay}`);
    connection.dispose();
  }
});

for (const legacy of [false, true])
for (const result of ["success", "network-error", "revoked", "disconnect", "dispose", "revoked-disconnect"])
test(`${legacy ? "Bucket" : "Instance"} connect waiting for resume handles ${result}`, async t => {
  const env = browser(t), original = env.instance();
  const initial = original.connect({ autoSync: false }); await env.approve(); await initial;
  stop(original);
  for (const key of await env.auth.keys("instance:app.example.com:session:")) await env.auth.remove(key);
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  env.setHandler(async call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    entered.resolve(); await release.promise;
    if (result === "network-error") throw new TypeError("Offline");
    if (result.startsWith("revoked")) return Response.json({ code: "GRANT_NOT_FOUND" }, { status: 403 });
    return Response.json({ credential: { carrier: "bearer", token: "restored", expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
  });
  const instance = env.instance();
  await instance.getBucket().get("missing");
  const restoring = instance.resume({ autoSync: false });
  const resumeResult = restoring.catch(error => error);
  await entered.promise;
  const authUrl = "https://myfield.one/auth/";
  const connecting = legacy ? instance.getBucket().connect({ autoSync: false }) : instance.connect({ autoSync: false });
  const connectResult = connecting.catch(error => error);
  let cancelled = Promise.resolve();
  if (result === "revoked-disconnect") instance.on("state", (_state, error) => {
    if (error?.code === "NOT_AUTHORIZED") cancelled = instance.disconnect();
  });
  await tick();
  const disconnecting = result === "disconnect" ? instance.disconnect() : Promise.resolve();
  if (result === "dispose") stop(instance);
  if (result !== "revoked") env.resetHandler();
  release.resolve();
  await disconnecting;
  if (result === "revoked") {
    assert.equal((await resumeResult).code, "NOT_AUTHORIZED");
    await until(() => env.opened.length === 2 && env.opened[1].location.href.includes("authRequest"));
    assert.equal(new URL(env.opened[1].location.href).origin, new URL(authUrl).origin);
    env.resetHandler();
    await env.approve();
    assert.equal(await connectResult, "connected");
  } else if (result === "success") {
    assert.equal(await resumeResult, "connected");
    assert.equal(await connectResult, "connected");
    assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  } else {
    const error = await resumeResult;
    assert.equal(error.name === "AbortError" || ["NETWORK_ERROR", "NOT_AUTHORIZED"].includes(error.code), true);
    const next = await connectResult;
    if (legacy) assert.equal(next, "disconnected");
    else assert.equal(result === "network-error" ? next.code : next.name, result === "network-error" ? "NETWORK_ERROR" : "AbortError");
  }
  await cancelled;
  assert.equal(env.opened.length, result === "revoked" ? 2 : 1);
});

test("Local CAS rejection retries without marking an unaccepted write as synchronized", async t => {
  const env = browser(t), instance = env.instance(), local = instance.getBucket();
  const connecting = instance.connect({ autoSync: false }); await env.approve(); await connecting;
  await local.put("note", { text: "pending" });
  let uploads = 0;
  const failures = [];
  instance.on("state", (_state, error) => { if (error) failures.push(error); });
  env.setHandler(call => {
    if (call.url.pathname.endsWith("/objects:index")) return Response.json({ objects: [], feedCursor: null, hasMoreFeed: false });
    if (call.url.pathname.endsWith("/current")) return Response.json({ versionId: null });
    uploads++;
    return Response.json({ ok: false, reason: "version-mismatch" });
  });
  await local.sync();
  assert.ok(failures.some(error => error.message.includes("CAS attempt limit")));
  assert.equal(uploads, 5);
  assert.equal((await local.get("note")).text, "pending");
  env.resetHandler();
  await local.sync();
  assert.ok(env.calls.some(call => call.body instanceof FormData));
});

test("an old Local activation failure cannot disconnect a newer authorization flow", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true });
  const entered = deferred(), release = deferred();
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ credential: { carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() } });
    entered.resolve(); return release.promise;
  });
  const old = instance.connect(); const rejected = assert.rejects(old, error => error.name === "AbortError");
  await env.approve(); await entered.promise;
  await instance.disconnect(); env.resetHandler();
  const next = instance.connect();
  release.resolve(Response.json({ versionId: null }));
  await rejected;
  await until(() => env.opened.length === 2); await env.approve();
  assert.equal(await next, "connected");
  assert.equal(instance.state, "connected");
});

test("Local verification network failure keeps shared access and sessions", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true });
  const failures = [];
  instance.on("state", (_state, error) => { if (error) failures.push(error); });
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ credential: { carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() } });
    throw new TypeError("Offline");
  });
  const connecting = instance.connect();
  await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(instance.state, "connected");
  assert.equal(instance.getBucket().state, "connected");
  assert.ok(failures.some(error => error.code === "NETWORK_ERROR" && error.retryable));
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
  assert.equal((await env.auth.keys("instance:app.example.com:session:")).length, 1);
  env.resetHandler();
  assert.equal(await instance.remote.getBucket().getCurrent("note"), null);
  assert.equal(await instance.resume(), "connected");
  assert.equal(env.opened.length, 1);
});

test("Local verification authorization failure disconnects shared access", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true });
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ credential: { carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() } });
    return Response.json({ code: "GRANT_REVOKED" }, { status: 403 });
  });
  const connecting = instance.connect(), failed = assert.rejects(connecting, code("NOT_AUTHORIZED"));
  await env.approve(); await failed;
  assert.equal(instance.state, "disconnected");
});

test("authUrl is used as the exact authorization page without endpoint inference", async t => {
  const env = browser(t), instance = createInstance({ appId: env.namespace, authUrl: "https://auth.example.test" });
  t.after(() => stop(instance));
  const first = instance.getBucket().connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  const page = new URL(env.opened[0].location.href);
  assert.equal(page.origin + page.pathname, "https://auth.example.test/");
  await env.approve();
  assert.equal(await first, "connected");
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  assert.equal(await env.data.get(`meta:${env.namespace}:endpoints`), null);
  assert.equal(env.calls.some(call => call.url.hostname === "api.auth.example.test"), false);
  assert.equal(env.opened.length, 1);
});

test("a repeated bucket connect joins the pending flow", async t => {
  const env = browser(t), local = env.instance().getBucket();
  const first = local.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  const second = local.connect({ autoSync: false });
  await env.approve();
  assert.deepEqual(await Promise.all([first, second]), ["connected", "connected"]);
  assert.equal(env.opened.length, 1);
});

test("legacy connect rejects outside a browser and resolves flow failures with a state error", async t => {
  const env = browser(t), local = env.instance().getBucket();
  const details = [];
  local.on("state", (state, detail) => { if (detail) details.push([state, detail]); });
  const connecting = local.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  env.opened[0].close();
  assert.equal(await connecting, "disconnected");
  assert.equal(details.at(-1)?.[0], "disconnected");
  const saved = globalThis.window;
  delete globalThis.window;
  try {
    await assert.rejects(local.connect(), code("INVALID_STATE"));
    assert.equal(await local.resume(), "disconnected");
  } finally { globalThis.window = saved; }
});

test("disposing the default Local handle releases it without disconnecting the Instance", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true });
  const connecting = instance.connect(); await env.approve(); await connecting;
  const old = instance.getBucket();
  old.dispose();
  const next = instance.getBucket();
  assert.notEqual(next, old);
  assert.equal(next.state, "connected");
  assert.equal(await instance.connect(), "connected");
  assert.equal(instance.state, "connected");
  await next.put("note", { text: "after dispose" });
  await next.sync();
  assert.ok(env.calls.some(call => call.body instanceof FormData));
});

test("disposing a connected non-default Local handle releases its connection", async t => {
  const env = browser(t), instance = env.instance();
  const archive = instance.createBucket({ id: "archive.example.com" });
  const connecting = archive.connect({ autoSync: false }); await env.approve();
  assert.equal(await connecting, "connected");
  await assert.rejects(instance.removeKey(), code("INVALID_STATE"));
  archive.dispose();
  const reopened = instance.createBucket({ id: "archive.example.com" });
  assert.notEqual(reopened, archive);
  assert.equal(reopened.state, "disconnected");
  assert.equal(await reopened.resume(), "connected");
  assert.equal(env.opened.length, 1);
  reopened.dispose();
  await instance.removeKey();
  assert.equal(await instance.getKey(), null);
});

for (const revoked of [false, true])
test(`Local 403 ${revoked ? "GRANT_REVOKED disconnects shared access" : "capability mismatch keeps access"}`, async t => {
  const env = browser(t), instance = env.instance(), local = instance.getBucket();
  const connecting = instance.connect({ autoSync: false }); await env.approve(); await connecting;
  env.setHandler(() => Response.json({ code: revoked ? "GRANT_REVOKED" : "GRANT_CAPABILITY_MISMATCH" }, { status: 403 }));
  await assert.rejects(local.sync());
  assert.equal(instance.state, revoked ? "disconnected" : "connected");
  assert.equal(local.state, instance.state);
});

test("enabling autoSync after an autoSync false connect starts sync without ready()", async t => {
  const env = browser(t), instance = env.instance(), local = instance.getBucket();
  const connecting = instance.connect({ autoSync: false }); await env.approve();
  assert.equal(await connecting, "connected");
  await tick();
  const before = env.calls.length;
  assert.equal(env.calls.slice(before).length, 0);
  local.setAutoSync(true);
  await until(() => env.calls.slice(before).some(call => call.url.pathname.endsWith("/objects:index")));
});

test("deprecated ready() does not open storage", async t => {
  const env = browser(t);
  let opens = 0;
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => { opens++; return realOpen(...args); };
  const local = env.instance().getBucket();
  await local.ready();
  assert.equal(opens, 0);
  await local.put("note", { text: "lazy" });
  assert.ok(opens > 0);
  assert.equal((await local.get("note")).text, "lazy");
});

test("automatic sync error details keep retry information from the original error", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true }), local = instance.getBucket();
  const connecting = instance.connect(); await env.approve();
  assert.equal(await connecting, "connected");
  const failures = [];
  instance.on("state", (_state, error) => { if (error) failures.push(error); });
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ code: "UNAVAILABLE" }, { status: 503, headers: { "retry-after": "7" } });
    return new Response(null, { status: 401 });
  });
  await local.put("note", { text: "pending" });
  for (let i = 0; i < 300 && !failures.some(error => error.message.startsWith("sync error")); i++) await new Promise(done => setTimeout(done, 10));
  const failure = failures.find(error => error.message.startsWith("sync error"));
  assert.ok(failure, JSON.stringify(failures.map(error => [error.code, error.message])));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryAfterMs, 7000);
  assert.equal(failure.status, 503);
  assert.equal(instance.state, "connected");
});

test("offline sync error reports do not repeat Local verification", async t => {
  const env = browser(t), instance = env.instance({ autoSync: true }), local = instance.getBucket();
  const failures = [];
  instance.on("state", (_state, error) => { if (error) failures.push(error); });
  env.setHandler(call => {
    if (call.url.pathname.endsWith("instance-challenge")) return Response.json({ challengeId: "challenge", challenge: "value" });
    if (call.url.pathname.endsWith("instance-session")) return Response.json({ credential: { carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() } });
    throw new TypeError("Offline");
  });
  const connecting = instance.connect(); await env.approve();
  assert.equal(await connecting, "connected");
  const syncErrors = () => failures.filter(error => error.message.startsWith("sync error")).length;
  const verifications = () => failures.length - syncErrors();
  await until(() => verifications() === 1 && syncErrors() === 1);
  await new Promise(done => setTimeout(done, 20));
  const before = env.calls.length;
  await local.put("note", { text: "offline" });
  for (let i = 0; i < 300 && syncErrors() < 2; i++) await new Promise(done => setTimeout(done, 10));
  await new Promise(done => setTimeout(done, 50));
  assert.equal(syncErrors(), 2);
  assert.equal(verifications(), 1);
  assert.equal(env.calls.slice(before).filter(call => call.url.pathname.endsWith("/current")).length, 1);
  assert.equal(instance.state, "connected");
});

const DEV_AUTH = "https://dev.example/auth/";
const pageOf = handle => { const url = new URL(handle.location.href); return url.origin + url.pathname; };

test("authUrl must be an exact absolute HTTP(S) page URL", () => {
  for (const authUrl of ["", "/auth/", "ftp://dev.example/auth/", "https://dev.example/auth/?env=dev",
    "https://dev.example/auth/#top", "https://user:secret@dev.example/auth/"]) {
    assert.throws(() => createInstance({ appId: "notes.example.com", storage: "memory", authUrl }), code("INVALID_INPUT"));
  }
});

test("authUrl selects the authorization page and access keeps the granted API address", async t => {
  const env = browser(t);
  const instance = createInstance({ appId: env.namespace, authUrl: "https://dev.example/auth/index.html" });
  t.after(() => stop(instance));
  const connecting = instance.connect({ autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  assert.equal(pageOf(env.opened[0]), "https://dev.example/auth/index.html");
  await env.approve();
  assert.equal(await connecting, "connected");
  assert.equal(await grantedApiOrigin(env.auth, env.namespace), "https://api.example.test");
  assert.equal(await env.data.get(`meta:${env.namespace}:endpoints`), null);
});

test("changing authUrl only selects where to authorize; saved access keeps its API address", async t => {
  const env = browser(t), prod = env.instance();
  const connecting = prod.connect({ autoSync: false }); await env.approve(); await connecting; stop(prod);
  const dev = createInstance({ appId: env.namespace, authUrl: DEV_AUTH });
  t.after(() => stop(dev));
  assert.equal(await dev.resume({ autoSync: false }), "connected");
  assert.equal(env.opened.length, 1);
  assert.equal(await dev.remote.getBucket().getCurrent("note"), null);
  assert.equal(env.calls.at(-1).url.origin, "https://api.example.test");
});

test("every bucket of an Instance uses its authUrl", async t => {
  const env = browser(t);
  const instance = createInstance({ appId: env.namespace, authUrl: DEV_AUTH });
  t.after(() => stop(instance));
  await assert.rejects(instance.getBucket().connect({ authBase: "https://custom.example/auth/" }), code("INVALID_INPUT"));
  const passthrough = instance.getBucket().connect({ authBase: undefined, autoSync: false });
  await until(() => env.opened[0]?.location.href.includes("authRequest"));
  assert.equal(pageOf(env.opened[0]), DEV_AUTH);
  await env.approve();
  assert.equal(await passthrough, "connected");
  const archive = instance.createBucket({ id: "archive.example.com" }).connect({ autoSync: false });
  await until(() => env.opened.length === 2 && env.opened[1].location.href.includes("authRequest"));
  assert.equal(pageOf(env.opened[1]), DEV_AUTH);
  await env.approve();
  assert.equal(await archive, "connected");
  assert.equal(await grantedApiOrigin(env.auth, env.namespace, "archive.example.com"), "https://api.example.test");
});

