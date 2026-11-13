import assert from "node:assert/strict";
import test from "node:test";
import { createInstanceKey } from "../src/auth/keys.ts";
import { createSession } from "../src/auth/session.ts";
import { createSessionClient } from "../src/remote/session.ts";
import { stableStringify } from "../src/internal/encoding.ts";

test("session workflow uses supplied keys and authenticates the server challenge without storage", async () => {
  const instance = await createInstanceKey();
  const identity = { mfid: "alias", resourceId: "urn:myfield:bucket:notes.example.com", instanceId: instance.instanceId };
  const challenge = { challengeId: "ch_1", challenge: "server-nonce" };
  const credential = { carrier: "bearer", token: "session-token", expiresAt: new Date(Date.now() + 7200_000).toISOString() };
  const paths = [];
  const publicKey = await crypto.subtle.importKey("jwk", instance.signingPublicJwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const client = createSessionClient(async (path, body) => {
    paths.push(path);
    if (path.endsWith("instance-challenge")) {
      assert.deepEqual(body, identity);
      return { ...challenge, mfid: "untrusted", resourceId: "other-resource" };
    }
    assert.deepEqual(Object.keys(body).sort(), [...Object.keys(identity), "challengeId", "proof", "credentialCarrier"].sort());
    assert.equal(body.credentialCarrier, "bearer");
    assert.equal(body.mfid, identity.mfid);
    assert.equal(body.resourceId, identity.resourceId);
    const payload = { v: 1, type: "instance-proof", ...identity, ...challenge, signedAt: body.proof.signedAt };
    const signature = Buffer.from(body.proof.signature, "base64url");
    const verify = payload => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
      signature, new TextEncoder().encode(stableStringify(payload)));
    assert.equal(await verify(payload), true);
    for (const field of ["mfid", "resourceId", "instanceId", "challenge", "challengeId", "signedAt"]) {
      assert.equal(await verify({ ...payload, [field]: "changed" }), false, `${field} is authenticated`);
    }
    return { credential };
  });
  const result = await createSession({ instance, mfid: identity.mfid, resourceId: identity.resourceId }, client);
  assert.deepEqual(result, credential);
  assert.deepEqual(paths, ["/v1/api/auth/instance-challenge", "/v1/api/auth/instance-session"]);
});
