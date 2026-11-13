import assert from "node:assert/strict";
import test from "node:test";
import { deriveInstanceId } from "../src/auth/keys.ts";

const publicJwk = {"kty": "EC", "crv": "P-256", "x": "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY", "y": "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"};
const expectedId = "inst_c71d01700fb0328870f1ab580c939eea";

test("instance ID matches the P-256 public-key derivation vector", async () => {
  assert.equal(await deriveInstanceId(publicJwk), expectedId);
});

test("instance ID ignores JWK annotations and property order", async () => {
  for (const metadata of [{ kid: "key-one" }, { alg: "ES256" }, { use: "sig" },
    { kid: "key-two", alg: "another-algorithm", use: "enc", ext: false, key_ops: ["verify"] }]) {
    assert.equal(await deriveInstanceId({ ...metadata, y: publicJwk.y, x: publicJwk.x,
      crv: publicJwk.crv, kty: publicJwk.kty }), expectedId);
  }
  assert.notEqual(await deriveInstanceId({ ...publicJwk, x: publicJwk.y }), expectedId);
});
