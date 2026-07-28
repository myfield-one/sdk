import assert from "node:assert/strict";
import test from "node:test";

import { createInstanceAuthClient, signInstanceChallenge } from "../src/auth/instance.ts";
import { createReferenceStorage } from "./helpers.mjs";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const utf8 = (value) => new TextEncoder().encode(value);

const BUCKET_ID = "app.example.com";
const RESOURCE_ID = `urn:myfield:bucket:${BUCKET_ID}`;
const ALIAS_MFID = "ab".repeat(16);
const KEY_ID = "bk_" + "3".repeat(32);
const GRANT_RECORD_ID = "ar_" + "4".repeat(32);

function decodeAuthRequestFragment(url) {
  const hash = new URL(url).hash;
  const encoded = new URLSearchParams(hash.slice(1)).get("authRequest");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function ecdhWrap(targetPublicJwk, aad, plaintextBytes) {
  const target = await crypto.subtle.importKey("jwk", targetPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: target }, ephemeral.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(aad) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, plaintextBytes));
  return {
    ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    salt: b64url(salt),
    iv: b64url(iv),
    aad,
    ciphertext: b64url(ciphertext),
  };
}

// Plays the /auth page side: wraps a fresh bucket key to the instance and
// returns the approved callback URL for the request captured from authorize().
async function buildApprovedCallback(authRequestWire, redirectUri, options = {}) {
  const remoteBucketId = options.remoteBucketId || BUCKET_ID;
  const remoteResourceId = `urn:myfield:bucket:${remoteBucketId}`;
  const rawBucketKey = crypto.getRandomValues(new Uint8Array(32));
  const grantAad = `myfield.auth.grant.bucket-key.v1|${remoteBucketId}`;
  const keyWrap = await ecdhWrap(authRequestWire.mf_instance_wrapping_jwk, grantAad, rawBucketKey);
  const bucketAccessGrant = {
    v: 1,
    grantRecordId: GRANT_RECORD_ID,
    mfid: ALIAS_MFID,
    resourceId: remoteResourceId,
    instanceId: authRequestWire.mf_instance_id,
    issuedAt: new Date().toISOString(),
    keyId: KEY_ID,
    capabilities: ["read", "write"],
    envelope: {
      kind: "bucket-key",
      bucketId: remoteBucketId,
      keyId: KEY_ID,
      targetInstanceId: authRequestWire.mf_instance_id,
      targetWrappingPublicJwk: authRequestWire.mf_instance_wrapping_jwk,
      wrapAlg: "ECDH-HKDF-SHA-256/AES-GCM-256",
      ...keyWrap,
    },
  };
  const storedResult = {
    v: 1,
    requestId: authRequestWire.mf_request_id,
    state: authRequestWire.state,
    result: "approved",
    mfid: ALIAS_MFID,
    resourceId: RESOURCE_ID,
    resourceApiUrl: "https://api.example.test/v1/api/sync",
    instanceId: authRequestWire.mf_instance_id,
    createdAt: new Date().toISOString(),
    bucketAccessGrant,
  };
  const resultAad = `myfield.auth.authorization-result.v1|${authRequestWire.mf_request_id}`;
  const resultWrap = await ecdhWrap(authRequestWire.mf_instance_wrapping_jwk, resultAad, utf8(JSON.stringify(storedResult)));
  const envelope = {
    v: 1,
    typ: "auth.authorization-result.envelope.v1",
    alg: "ECDH-HKDF-SHA-256/AES-GCM-256",
    requestId: authRequestWire.mf_request_id,
    state: authRequestWire.state,
    resourceId: RESOURCE_ID,
    instanceId: authRequestWire.mf_instance_id,
    ...resultWrap,
  };
  const callback = new URL(redirectUri);
  callback.searchParams.set("state", authRequestWire.state);
  callback.searchParams.set("mf_request_id", authRequestWire.mf_request_id);
  callback.searchParams.set("mf_result", "approved");
  callback.hash = `mf_auth_result=${b64url(utf8(JSON.stringify(envelope)))}`;
  return { callbackUrl: callback.toString(), rawBucketKey };
}

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
