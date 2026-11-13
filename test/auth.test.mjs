import assert from "node:assert/strict";
import test from "node:test";

import { createInstanceAuthClient, signInstanceChallenge } from "../src/auth/instance.ts";
import { decodeAuthRequestFragment, buildApprovedCallback } from "./auth-fixture.mjs";
import { createReferenceStorage } from "./helpers.mjs";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const utf8 = (value) => new TextEncoder().encode(value);

const BUCKET_ID = "app.example.com";
const RESOURCE_ID = `urn:myfield:bucket:${BUCKET_ID}`;
const ALIAS_MFID = "ab".repeat(16);
const KEY_ID = "bk_" + "3".repeat(32);
const GRANT_RECORD_ID = "ar_" + "4".repeat(32);

function makeAuthClient(overrides = {}) {
  let capturedAuthUrl = null;
  const client = createInstanceAuthClient({
    appId: BUCKET_ID,
    apiBase: "https://api.example.test",
    authPageUrl: "https://myfield.test/auth",
    redirectUri: "https://app.example.com/",
    origin: "https://app.example.com",
    storage: createReferenceStorage(),
    openAuthUrl: (url) => {
      capturedAuthUrl = url;
    },
    ...overrides,
  });
  return { client, authUrl: () => capturedAuthUrl };
}

test("authorize builds a v1 request and callback establishes context", async () => {
  const { client, authUrl } = makeAuthClient();
  await client.authorize({ bucketId: BUCKET_ID });
  const wire = decodeAuthRequestFragment(authUrl());
  assert.equal(wire.mf_auth_mode, "v1", "SDK v1 mode is hardcoded");
  assert.equal(wire.resource_id, RESOURCE_ID);
  assert.equal(wire.scope, "read write");
  assert.match(wire.mf_instance_id, /^inst_[a-f0-9]{32}$/);

  const { callbackUrl } = await buildApprovedCallback(wire, "https://app.example.com/");
  const result = await client.handleCallback(callbackUrl);
  assert.equal(result.result, "approved");

  const context = await client.getContext(BUCKET_ID);
  assert.ok(context, "context established");
  assert.equal(context.mfid, ALIAS_MFID, "app sees the alias mfid");

  const access = await client.getBucketAccess(BUCKET_ID);
  assert.equal(access.bucketId, BUCKET_ID);
  assert.match(await access.keys.wireObjectId("note:1"), /^ob_[0-9a-f]{32}$/, "bucket keys unwrap and blind ids");
});

test("bucket access uses the grant envelope remote bucket id", async () => {
  const { client, authUrl } = makeAuthClient();
  await client.authorize({ bucketId: BUCKET_ID });
  const wire = decodeAuthRequestFragment(authUrl());
  const { callbackUrl } = await buildApprovedCallback(wire, "https://app.example.com/", { remoteBucketId: "remote.example.com" });
  await client.handleCallback(callbackUrl);

  const access = await client.getBucketAccess(BUCKET_ID);
  assert.equal(access.bucketId, "remote.example.com");
  assert.equal(access.resourceId, "urn:myfield:bucket:remote.example.com");
  assert.equal(access.keys.bucketId, "remote.example.com");
});

test("session establishment signs the instance challenge and caches the bearer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith("/instance-challenge")) {
      return Response.json({ challengeId: "ch_1", challenge: "challenge-value" });
    }
    if (String(url).endsWith("/instance-session")) {
      const proof = JSON.parse(init.body).proof;
      if (proof?.type !== "instance.es256" || !proof.signature) return new Response("bad proof", { status: 400 });
      return Response.json({ credential: { carrier: "bearer", token: "tok_1", expiresAt: new Date(Date.now() + 7200_000).toISOString() } });
    }
    return new Response("not found", { status: 404 });
  };
  const { client, authUrl } = makeAuthClient({ fetchImpl });
  await client.authorize({ bucketId: BUCKET_ID });
  const wire = decodeAuthRequestFragment(authUrl());
  const { callbackUrl } = await buildApprovedCallback(wire, "https://app.example.com/");
  await client.handleCallback(callbackUrl);

  const session = await client.getSession(BUCKET_ID);
  assert.equal(session.carrier, "bearer");
  assert.equal(session.token, "tok_1");
  assert.equal(calls.length, 2, "challenge + session");
  assert.equal(calls[0].body.mfid, ALIAS_MFID, "session rides on the alias mfid");

  const again = await client.getSession(BUCKET_ID);
  assert.equal(again.token, "tok_1");
  assert.equal(calls.length, 2, "cached session is reused");
});

test("denied callback does not establish context", async () => {
  const { client, authUrl } = makeAuthClient();
  await client.authorize({ bucketId: BUCKET_ID });
  const wire = decodeAuthRequestFragment(authUrl());
  const callback = new URL("https://app.example.com/");
  callback.searchParams.set("state", wire.state);
  callback.searchParams.set("mf_request_id", wire.mf_request_id);
  callback.searchParams.set("mf_result", "denied");
  callback.searchParams.set("error", "access_denied");
  const result = await client.handleCallback(callback.toString());
  assert.equal(result.result, "denied");
  assert.equal(await client.getContext(BUCKET_ID), null);
});

test("instance challenge proof verifies against the signing key", async () => {
  const { client } = makeAuthClient();
  const instance = await client.ensureInstance();
  const proof = await signInstanceChallenge({
    instance,
    challenge: "challenge-value",
    challengeId: "ch_1",
    mfid: ALIAS_MFID,
    resourceId: RESOURCE_ID,
  });
  assert.equal(proof.type, "instance.es256");
  const publicKey = await crypto.subtle.importKey("jwk", instance.signingPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const payload = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        challenge: "challenge-value",
        challengeId: "ch_1",
        instanceId: instance.instanceId,
        mfid: ALIAS_MFID,
        resourceId: RESOURCE_ID,
        signedAt: proof.signedAt,
        type: "instance-proof",
        v: 1,
      }).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(proof.signature, "base64url"),
    utf8(payload)
  );
  assert.ok(valid, "proof signature verifies");
});

test("reopening IndexedDB reuses nonextractable instance keys and the existing record layout", async () => {
  await import("fake-indexeddb/auto");
  const { createIndexedDbStorageAdapter } = await import("../src/bucket/store.ts");
  const dbName = `auth-reopen-${crypto.randomUUID()}`;
  const firstStore = createIndexedDbStorageAdapter({ dbName });
  const first = await makeAuthClient({ storage: firstStore }).client.ensureInstance();
  const before = (await firstStore.keys("")).sort();
  const secondStore = createIndexedDbStorageAdapter({ dbName });
  const second = await makeAuthClient({ storage: secondStore }).client.ensureInstance();
  assert.equal(second.instanceId, first.instanceId);
  assert.deepEqual(second.signingPublicJwk, first.signingPublicJwk);
  assert.deepEqual(second.wrappingPublicJwk, first.wrappingPublicJwk);
  assert.deepEqual((await secondStore.keys("")).sort(), before);
  for (const key of [second.signingPrivateKey, second.wrappingPrivateKey]) {
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("jwk", key));
  }
  const proof = await signInstanceChallenge({ instance: second, challenge: "reopened", mfid: ALIAS_MFID, resourceId: RESOURCE_ID });
  const publicKey = await crypto.subtle.importKey("jwk", first.signingPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const payload = Object.fromEntries(Object.entries({ v: 1, type: "instance-proof", instanceId: first.instanceId,
    challenge: "reopened", challengeId: "", mfid: ALIAS_MFID, resourceId: RESOURCE_ID, signedAt: proof.signedAt }).sort());
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
    Buffer.from(proof.signature, "base64url"), utf8(JSON.stringify(payload))), true);
});

for (const failedRoute of ["instance-challenge", "instance-session"]) {
  test(`session ${failedRoute} failure preserves authorization and permits a later retry`, async () => {
    let fail = true;
    const calls = [];
    const storage = createReferenceStorage();
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (fail && String(url).endsWith(failedRoute)) return new Response("unavailable", { status: 503 });
      if (String(url).endsWith("instance-challenge")) return Response.json({ challengeId: "ch_retry", challenge: "retry" });
      return Response.json({ credential: { carrier: "bearer", token: "retry-token", expiresAt: new Date(Date.now() + 7200_000).toISOString() } });
    };
    const { client, authUrl } = makeAuthClient({ storage, fetchImpl });
    await client.authorize({ bucketId: BUCKET_ID });
    await client.handleCallback((await buildApprovedCallback(decodeAuthRequestFragment(authUrl()), "https://app.example.com/")).callbackUrl);
    const before = await client.getContext(BUCKET_ID);
    const identity = await client.ensureInstance();
    await assert.rejects(client.getSession(BUCKET_ID), /503/);
    assert.deepEqual(await client.getContext(BUCKET_ID), before);
    assert.equal(calls.length, failedRoute === "instance-challenge" ? 1 : 2, "no automatic retry");
    fail = false;
    const [first, second] = await Promise.all([client.getSession(BUCKET_ID), client.getSession(BUCKET_ID)]);
    assert.equal(first.token, "retry-token");
    assert.deepEqual(first, second);
    assert.equal(calls.length, (failedRoute === "instance-challenge" ? 1 : 2) + 2, "concurrent refresh is shared");
    assert.ok(calls.every(call => call.body.instanceId === identity.instanceId));
    await client.getSession(BUCKET_ID, { forceRefresh: true });
    assert.equal(calls.length, (failedRoute === "instance-challenge" ? 1 : 2) + 4);
    const reopened = makeAuthClient({ storage, fetchImpl }).client;
    assert.equal((await reopened.getSession(BUCKET_ID)).token, "retry-token");
    assert.equal(calls.length, (failedRoute === "instance-challenge" ? 1 : 2) + 4, "saved bearer is reused after reopening");
  });
}
