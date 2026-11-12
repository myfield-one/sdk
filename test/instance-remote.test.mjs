import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { instanceTestCleanup } from "../src/facade.ts";
import { createInstance, ClientError } from "../src/index.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { createIndexedDbStorageAdapter } from "../src/bucket/store.ts";
import { decodeAuthRequestFragment, buildApprovedCallback } from "./auth-fixture.mjs";

const stop = instance => instanceTestCleanup.get(instance)?.();

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
    open() {
      if (!popup) return null;
      const handle = { location: { href: "about:blank" }, closed: false,
        close() { this.closed = true; }, focus() {}, document: { title: "", body: {} } };
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
    instance() { const result = createInstance(namespace); instances.push(result); return result; },
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
  const b = createInstance({ namespace: env.namespace });
  t.after(() => stop(b));
  assert.equal(a.remote.getBucket(), a.remote.getBucket());
  await assert.rejects(a.remote.getBucket().getCurrent("note"), code("NOT_AUTHORIZED"));
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
  assert.throws(() => createInstance({ namespace: "notes", authUrl: "https://custom.example/auth/" }), code("INVALID_INPUT"));
  assert.equal("dispose" in a, false);
});

test("connect joins authorization, persists legacy context/endpoints and uses callback remote bucket", async t => {
  const env = browser(t), instance = env.instance();
  const first = instance.connect();
  assert.equal(instance.connect(), first);
  const { wire } = await env.approve({ remoteBucketId: "remote.example.com" });
  await first;
  assert.equal(wire.resource_id, `urn:myfield:bucket:${env.namespace}`);
  assert.deepEqual(await env.data.get(`meta:${env.namespace}:endpoints`), {
    authBase: "https://myfield.one/auth/", apiBase: "https://api.example.test",
  });
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

test("disconnect clears access but preserves endpoints, identity and data", async t => {
  const env = browser(t), instance = env.instance();
  await env.data.set("data:unrelated:obj:note", { text: "local" });
  const first = instance.connect(); await env.approve(); await first;
  const before = await env.auth.get("instance:app.example.com:active-instance:current");
  const handle = instance.remote.getBucket();
  await instance.disconnect();
  assert.equal((await env.data.get(`meta:${env.namespace}:endpoints`))?.authBase, "https://myfield.one/auth/");
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
  assert.equal((await env.data.get(`meta:${env.namespace}:endpoints`)).authBase, "https://myfield.one/auth/");
});

test("same-named legacy bucket blocks Instance APIs without changing legacy connection", async t => {
  const env = browser(t), instance = env.instance();
  const remote = instance.remote.getBucket();
  const local = instance.createBucket({ id: env.namespace });
  assert.throws(() => instance.remote.getBucket(), code("INVALID_STATE"));
  await assert.rejects(remote.getCurrent("note"), code("INVALID_STATE"));
  await assert.rejects(instance.connect(), code("INVALID_STATE"));
  await assert.rejects(instance.resume(), code("INVALID_STATE"));
  await assert.rejects(instance.disconnect(), code("INVALID_STATE"));
  const connecting = local.connect({ autoSync: false });
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  env.opened.at(-1).close();
  assert.equal(await connecting, "disconnected");
  await local.disconnect();
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

test("session failure after approval keeps endpoints and resumes after reopening", async t => {
  const env = browser(t); let instance = env.instance();
  env.setHandler(() => new Response("unavailable", { status: 503 }));
  const connecting = instance.connect(); const failed = assert.rejects(connecting, error => error.status === 503 && error.retryable);
  await env.approve(); await failed;
  assert.equal((await env.auth.keys("instance:app.example.com:context:")).length, 1);
  assert.equal((await env.data.get(`meta:${env.namespace}:endpoints`)).apiBase, "https://api.example.test");
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
  const connection = createInstanceConnection({ namespace: env.namespace, data: env.data, auth, hasLegacyBucket: () => false });
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

test("resume and user connect join one flow and report isolated state events", async t => {
  const env = browser(t), instance = env.instance(), events = [];
  const unsubscribe = instance.on("state", (state, error) => events.push([state, error?.code]));
  instance.on("state", () => { throw new Error("Application listener failure"); });
  const resuming = instance.resume();
  const connecting = instance.connect();
  assert.equal(resuming, connecting);
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

test("creating a same-named legacy bucket invalidates Instance connection, but legacy resume still works", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); await env.approve(); await connecting;
  const remote = instance.remote.getBucket();
  const local = instance.createBucket({ id: env.namespace });
  assert.equal(instance.state, "disconnected");
  await assert.rejects(remote.getCurrent("note"), code("INVALID_STATE"));
  await assert.rejects(instance.resume(), code("INVALID_STATE"));
  assert.equal(await local.resume(), "connected");
  assert.equal(env.opened.length, 1);
  local.dispose();
  await assert.rejects(instance.connect(), code("INVALID_STATE"));
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

test("creating same-named legacy bucket cancels an active Instance popup without wrapping legacy methods", async t => {
  const env = browser(t), instance = env.instance();
  const connecting = instance.connect(); const cancelled = assert.rejects(connecting, code("INVALID_STATE"));
  await until(() => env.opened.at(-1)?.location.href.includes("authRequest"));
  const local = instance.createBucket({ id: env.namespace });
  await cancelled; assert.equal(env.opened[0].closed, true);
  const legacyConnect = local.connect({ autoSync: false });
  await until(() => env.opened.length === 2);
  await env.approve();
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
