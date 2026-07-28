# @myfield/sdk

Myfield open SDK for third-party web apps: local-first object storage,
end-to-end-encrypted sync, and internal Myfield authorization.

The mental model: a bucket is a local-first **end-to-end-encrypted object KV
with CAS-backed sync**. Local CRUD works with no account and no network;
`connect()` is the single identity/network boundary. The cloud is a relay,
not an archive — objects may be missing in cloud (old data rotates out),
uploads may transiently fail (rate limits), and local storage is the source
of truth.

Status: 1.0 preview. `0.9.0` reflects our assessment that the SDK design has
reached its baseline shape; minor adjustments — including to the public API
— are still possible before 1.0 based on community feedback and real-world
use, and 1.0 will freeze the API/protocol, with later versions extending it
while keeping compatibility. License: Apache-2.0.

## Quickstart

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance(); // namespace defaults to "default"
const bucket = instance.createBucket({ id: "app.example.com" });

// On startup: resume an existing authorization / handle an auth callback.
await bucket.resume();

// Local-first object CRUD works before authorization.
await bucket.put("note:1", { title: "hello", body: "world" });
const note = await bucket.get("note:1");
await bucket.update("note:1", { body: undefined }); // deletes the field
const entries = await bucket.list({ prefix: "note:" });

// On the user's "Connect" click: run the authorization flow (popup, or
// same-tab on iOS).
await bucket.connect(); // defaults to https://myfield.one/auth/
```

## What the SDK handles

- **Auth**: instance keygen, the `https://myfield.one/auth/` authorization
  flow (popup / same-tab), callback decryption, bearer session refresh, and
  the unauthorized → disconnected transition. Apps see bucket
  `connect()` / `disconnect()` / state events only.
- **Pairwise identity**: authorization is alias-only. Your app sees an alias
  id for the user, never their global Myfield identity; different apps see
  different aliases and cannot correlate users across apps.
- **Encryption**: payloads are encrypted client-side; the platform stores
  ciphertext only. Object ids are blinded — your semantic ids
  (`note:1`, `note:list`) never reach the wire.
- **Merge**: objects are field maps with last-write-wins per field
  (a state-based CRDT), so multi-device edits converge without conflicts
  surfacing to the app. Custom merge strategies (e.g. Yjs documents) can be
  plugged per object.
- **Sync triggers**: launch/resume, post-write debounce, and a timer
  fallback. Browser lifecycle triggers such as focus/visibility are app
  choices: call `bucket.sync()` from those handlers when that fits your UI.
  No server push in v1.

## Honest boundaries

- **The cloud is a sync relay, not a backup.** Free-tier data rotates
  (oldest-first) under space pressure and after a retention window. Any
  device holding the data re-uploads it automatically (self-healing), but if
  every local copy is gone, rotated cloud data is not recoverable. Data
  durability is owned by the app and the user.
- **Privacy boundary**: id blinding and encryption hide semantics, not
  traffic patterns — the platform still observes opaque-object write timing,
  sizes, and counts. Authorization revocation revokes access; it does not
  rotate the bucket key already held by a revoked device.
- **Browser boundary**: Web/PWA clients cannot hide the browser `Origin`
  header from sync/auth requests. Native or CLI transports can avoid browser
  Origin, but Web SDK privacy does not rely on that, and bucket/AI resource
  authorization should not rely on it either.
- **Freshness, not realtime collaboration**: the pull model targets
  single-user multi-device freshness, not millisecond multi-user
  collaboration or presence.

## Current service status

The public SDK facade no longer exposes `apiBase`. The auth service returns
`resourceApiUrl` in the encrypted callback result, so SDKs do not encode
deployment host rules. The SDK uses `bucketAccessGrant.resourceId` as the
remote sync resource id, with `envelope.bucketId` treated as optional
compatibility metadata.

Service work still needed before public release:

- Auth-managed opaque alias bucket allocation for newly created buckets.
  Current SDK/callback code can consume an alias `bucketAccessGrant.resourceId`;
  auth still needs the durable original-to-alias bucket binding and migration
  policy.
- Worker sync authorization based on the grant alias resource id, including
  tests where original and alias bucket ids differ.
- A bucket-scoped hibernatable WebSocket feed under the resource API root.
  SSE remains compatibility/development-only; SDK fallback is
  timer/index-diff sync.

## Public entry

| Entry | Contents |
| --- | --- |
| `@myfield/sdk` | `createInstance` facade, bucket types, connection state, and SDK error classes |

Local persistence defaults to IndexedDB. A memory backend is available for
tests and ephemeral clients; custom storage factories are lower-level
building blocks, not the v1 quickstart API.

Internal source modules under `src/auth` and `src/bucket` exist for
implementation and tests, but are not exported package subpaths in v1.

Compatible implementation details for SDK maintainers and future language
ports (payload layout, merge rules, id derivation): see
[`docs/BUCKET-SPEC.md`](./docs/BUCKET-SPEC.md).

## Development

This package is dependency-free at runtime and managed independently of the
monorepo workspace (standalone lockfile) so it can be extracted cleanly.

```sh
pnpm install --ignore-workspace
npm test          # node --test (contract layer, mocked relay/auth)
npm run typecheck # tsc --noEmit
```

Repository-level maintainer browser E2E lives under `tests/sdk-e2e/` and is
run from the workspace root with `pnpm run test:sdk:e2e`.
