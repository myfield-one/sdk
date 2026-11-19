# @myfield/sdk

MyField SDK for third-party web apps: local-first object storage,
end-to-end-encrypted sync, and internal MyField authorization.

A bucket is a local-first **end-to-end-encrypted object KV with CAS-backed sync**.
Local CRUD works without an account or network; `connect()` authorizes cloud access.

Status: pre-1.0 preview; public APIs may change before 1.0. License: Apache-2.0.

## Quickstart

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance("notes.example.com");
const bucket = instance.getBucket();

// Local-first object CRUD works before authorization.
await bucket.put("note:1", { title: "hello", body: "world" });
const note = await bucket.get("note:1");
await bucket.update("note:1", { body: undefined }); // deletes the field
const entries = await bucket.list({ prefix: "note:" });

// Restore access in the background after loading local data.
void instance.resume().catch(error => console.error("Connection failed:", error));

// On the user's "Connect" click: run the authorization flow (popup, or
// same-tab on iOS).
await instance.connect(); // defaults to https://myfield.one/auth/
```

Full API reference: [`docs/API.md`](docs/API.md).

## Remote object access

`instance.remote.getBucket()` provides object reads, CAS commits, version history and
change notifications with the instance's authorization; the app owns payload encryption
and local storage, encrypting with `getBucketKey()`. See
[Remote Object API](docs/API.md#remote-object-api).

## What the SDK handles

- **Auth**: instance keygen, the `https://myfield.one/auth/` authorization
  flow (popup / same-tab), callback decryption, bearer session refresh, and
  the unauthorized → disconnected transition. Apps use Instance
  `connect()` / `disconnect()` / state events only.
- **Pairwise identity**: apps receive app-specific aliases rather than the user's
  primary Myfield identity.
- **Encryption**: Local payloads are encrypted client-side; the platform stores
  ciphertext only. Object ids are blinded — your semantic ids
  (`note:1`, `note:list`) never reach the wire. Remote apps encrypt their own payloads.
- **Merge**: Local objects use last-write-wins per top-level field to merge
  changes across devices.
- **Sync triggers**: launch/resume, post-write debounce, and a timer
  fallback. Browser lifecycle triggers such as focus/visibility are app
  choices: call `bucket.sync()` from those handlers when that fits your UI.

## Honest boundaries

- **Recovery** depends on the cloud service's durability, retention and backup
  guarantees, and on retaining access to decryption keys.
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

## Public entry

| Entry | Contents |
| --- | --- |
| `@myfield/sdk` | `createInstance`, `instance.remote.getBucket`, public types and error classes |

Local persistence defaults to IndexedDB. A memory backend is available for
tests and ephemeral clients; custom storage factories are lower-level
building blocks, not the v1 quickstart API.

Internal source modules under `src/auth` and `src/bucket` exist for
implementation and tests, but are not exported package subpaths in v1.

Compatible implementation details for SDK maintainers and future language
ports (payload layout, merge rules, id derivation): see
[`docs/BUCKET-SPEC.md`](./docs/BUCKET-SPEC.md).

## Development

This package has no runtime dependencies and uses a standalone pnpm lockfile.

```sh
pnpm install
npm run build
npm test          # node --test (contract layer, mocked relay/auth)
npm run typecheck # tsc --noEmit
npm run typecheck:api # public declarations
MYFIELD_TEST_AUTH_URL="https://your-test-host/auth/" npm run verify:remote
```

`verify:remote` is the SDK's standalone Remote API smoke check against a test service.
