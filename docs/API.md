# @myfield/sdk API (v1 draft)

`@myfield/sdk` exposes a local-first encrypted object bucket. Local reads and
writes work without an account. `connect()` binds the bucket to Myfield auth and
encrypted sync.

## Quickstart

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance();
const bucket = instance.createBucket({ id: "app.example.com" });

await bucket.put("note:1", { title: "hello", body: "world" });
const note = await bucket.get("note:1");
const notes = await bucket.list({ prefix: "note:" });

await bucket.connect();
```

## `createInstance(options?)`

```ts
function createInstance(options?: {
  namespace?: string;                // default "default"
  storage?: "indexeddb" | "memory";  // default "indexeddb"
}): Instance;
```

- `namespace` is a local storage scope. It defaults to `"default"` and must
  match `a-z0-9`, max 32 chars.
- `storage: "indexeddb"` persists local data, instance keys, auth context, and
  sync metadata.
- `storage: "memory"` keeps all state process-local and ephemeral.

## `instance.createBucket(options)`

```ts
instance.createBucket(options: { id: string }): Bucket;
```

- `id` is required. Use a stable domain-shaped id, usually the app host, for
  example `"app.example.com"`.
- Creating a bucket is local-only: no network and no account.
- The local bucket id is the user-facing resource label. Myfield may bind it to
  a different remote bucket id during `connect()`; apps must not assume they
  are the same.
- Valid ids use lowercase `a-z0-9`, `.`, and `-`, max 63 chars.

## Local Object API

Local operations work before `connect()` and never wait for network sync.

```ts
bucket.ready(): Promise<void>;

bucket.put(id: string, object: Record<string, unknown>): Promise<void>;
bucket.update(id: string, fields: Record<string, unknown>): Promise<void>;
bucket.delete(id: string): Promise<void>;

bucket.get(id: string): Promise<Record<string, unknown> | null>;
bucket.binary(input: Blob | File | ArrayBuffer | Uint8Array, options?: {
  mimeType?: string;
  name?: string;
  lastModified?: number;
}): BucketBinaryValue;
bucket.list(options?: {
  prefix?: string;
  includeDeleted?: boolean; // default false
}): Promise<Array<{ id: string; updatedAt: string; deleted?: true }>>;
```

### Write Semantics

- `put(id, object)` writes a whole object from this device's point of view.
  Omitted fields that this device already knows are deleted; fields unknown
  locally, such as concurrent remote additions, are preserved on merge.
- `update(id, fields)` writes top-level fields and preserves omitted fields.
  Setting a field to `undefined` deletes it. Updating a missing/deleted object
  recreates it.
- Unchanged field values do not advance field timestamps.
- Merge granularity is top-level fields. Nested values are replaced wholesale.

### Binary Fields

Binary content is stored as a typed field value. The SDK does not interpret file
semantics; app-owned fields such as `name`, `mimeType`, `size`, or `kind` remain
ordinary application data.

```ts
await bucket.put("file:1", {
  kind: "file",
  name: file.name,
  mimeType: file.type,
  size: file.size,
  content: bucket.binary(file),
});

const saved = await bucket.get("file:1");
const content = saved?.content;
if (content?.kind === "binary") {
  const blob = await content.blob();
  const bytes = await content.arrayBuffer();
}
```

`bucket.binary()` accepts `Blob`, `File`, `ArrayBuffer`, and `Uint8Array`.
Read-side binary values expose:

```ts
type BucketBinaryValue = {
  kind: "binary";
  size: number;
  mimeType?: string;
  name?: string;
  lastModified?: number;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
};
```

Binary fields are inline in the same encrypted SDK object payload. They use the
same field-level LWW ordering as other fields. The worker API is unchanged and
continues to see only opaque encrypted object payloads.

The SDK enforces a 100 MiB (`100 * 1024 * 1024` bytes) object-level encoded
payload size cap. Apps requiring larger data should model chunks as separate objects; chunking is
application-owned and is not a public SDK API concept.

### Read And List

- `get(id)` returns the local object or `null` when absent, deleted, or not
  locally available.
- `list()` returns the local known-object index, newest first. It is not a
  query/search API.
- Object ids and field names starting with `~` are reserved and rejected.

## Connection API

```ts
bucket.resume(): Promise<void>;

bucket.connect(options?: {
  authBase?: string;  // default "https://myfield.one/auth/"
  autoSync?: boolean; // default true
}): Promise<void>;

bucket.sync(): Promise<void>;
bucket.setAutoSync(enabled: boolean): void;
bucket.disconnect(): Promise<void>;

bucket.state; // "disconnected" | "connecting" | "connected"

const offState = bucket.on("state", (state, detail?) => {});
const offChange = bucket.on("change", (objectId) => {});
```

- Call `resume()` on app boot. It completes pending auth callbacks and restores
  existing authorization without prompting.
- Call `connect()` from a user gesture. It may open the Myfield auth page.
- `authBase` defaults to `https://myfield.one/auth/`. API endpoints are not
  public SDK options.
- With `autoSync`, the SDK syncs after connecting and after local writes.
- Browser lifecycle sync is app-owned. Apps may call `bucket.sync()` on focus,
  visibility, or online events.
- `disconnect()` drops the remote binding and authorization. Local data stays.

## Events

```ts
bucket.on("state", (state, detail) => {
  // state: "disconnected" | "connecting" | "connected"
});

bucket.on("change", (objectId) => {
  // Re-read with bucket.get(objectId)
});
```

The returned function unsubscribes the listener.

## Errors

- Invalid bucket ids, object ids, field names, or oversized objects reject the
  returned promise.
- `sync()` while disconnected rejects with `NotConnectedError`.
- Retryable sync failures, such as offline, rate limits, or 5xx responses, are
  surfaced through state details and retried by auto-sync.
- A cloud miss is not an error. `get()` returns `null`, and another device that
  still has the object can re-upload it on sync.

## Boundaries

- Myfield sync is a relay, not a backup. Apps should keep their own export or
  durability story when user data must be archival.
- Content and object ids are encrypted/blinded before reaching Myfield. Traffic
  timing, sizes, and counts are still visible to the platform.
- Web clients cannot hide the browser `Origin` header from sync/auth requests.
- v1 is freshness sync, not realtime collaborative editing.

## Not In V1

- Custom storage adapters.
- Query, pagination, ordering, or full-text search.
- Public subpaths such as `@myfield/sdk/auth` or `@myfield/sdk/bucket`.
- Capability negotiation APIs.
- External KV mutation detection.
- Public feed, batch, snapshot, or version-history APIs.
- `setFields()` / `getFields()` as the quickstart path.
