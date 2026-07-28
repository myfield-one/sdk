import assert from "node:assert/strict";
import test from "node:test";

import { b64urlToBytes, bytesToB64url } from "../src/internal/encoding.ts";

test("base64url roundtrips byte arrays without atob/btoa", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 1]),
    new Uint8Array([0, 1, 2]),
    new Uint8Array([251, 255, 238, 252, 253]),
    new TextEncoder().encode("hello world"),
  ];
  for (const bytes of cases) {
    assert.deepEqual(b64urlToBytes(bytesToB64url(bytes)), bytes);
  }
});

test("base64url decoder accepts padded standard base64 input", () => {
  assert.deepEqual(b64urlToBytes("+/7="), new Uint8Array([251, 254]));
});

test("base64url decoder rejects malformed input", () => {
  assert.throws(() => b64urlToBytes("abcde"), /invalid base64url length/);
  assert.throws(() => b64urlToBytes("abc!"), /invalid base64url character/);
});
