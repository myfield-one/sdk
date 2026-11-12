const b64url = bytes => Buffer.from(bytes).toString("base64url");
const utf8 = value => new TextEncoder().encode(value);
const ALIAS_MFID = "ab".repeat(16);
const KEY_ID = "bk_" + "3".repeat(32);
const GRANT_RECORD_ID = "ar_" + "4".repeat(32);

export function decodeAuthRequestFragment(url) {
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
export async function buildApprovedCallback(authRequestWire, redirectUri, options = {}) {
  const remoteBucketId = options.remoteBucketId || authRequestWire.resource_id.split(":").at(-1);
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
    resourceId: authRequestWire.resource_id,
    resourceApiUrl: options.apiBase || "https://api.example.test/v1/api/sync",
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
    resourceId: authRequestWire.resource_id,
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
