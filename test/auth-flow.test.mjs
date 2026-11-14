import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationFlow } from "../src/auth/flow.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { createMemoryStorageAdapter } from "../src/bucket/store.ts";
import { decodeAuthRequestFragment, buildApprovedCallback } from "./auth-fixture.mjs";

for (const selected of [false, true])
test(`authorization flow accepts only its ${selected ? "selected" : "default"} bucket callback`, async () => {
  const appId = "app.example.com", bucketId = selected ? "archive.example.com" : appId;
  const storage = createMemoryStorageAdapter();
  let target;
  const auth = createInstanceAuthClient({ appId, storage, origin: "https://app.example.com",
    redirectUri: "https://app.example.com/", authPageUrl: "https://auth.example.com/auth/",
    openAuthUrl: url => { target = url; } });
  await auth.authorize({ bucketId });
  const wire = decodeAuthRequestFragment(target);
  const callback = new URL((await buildApprovedCallback(wire, "https://app.example.com/")).callbackUrl);
  const own = createAuthorizationFlow({ getAppId: () => appId, ...(selected ? { getBucketId: () => bucketId } : {}) });
  const other = createAuthorizationFlow({ getAppId: () => appId, getBucketId: () => "other.example.com" });
  assert.equal(wire.client_id, appId);
  assert.equal(wire.resource_id, `urn:myfield:bucket:${bucketId}`);
  assert.equal(await other.ownCallback(callback, storage), false);
  assert.equal(await own.ownCallback(callback, storage), true);
  await own.handleCallback(auth, callback, new AbortController().signal, false);
  assert.equal((await auth.getContext(bucketId)).resourceId, wire.resource_id);
  assert.equal(await own.ownCallback(callback, storage), false);
});
