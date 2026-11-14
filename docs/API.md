# @myfield/sdk API (v1 draft)

`@myfield/sdk` exposes a local-first encrypted object bucket. Local reads and
writes work without an account. `connect()` binds the bucket to Myfield auth and
encrypted sync.

For an overview, quickstart and service boundaries, see the [README](../README.md).

## `createInstance`

```ts
createInstance(appId: string): Instance;
createInstance(options?: {
  appId?: string;
  namespace?: string; // Existing storage scope.
  storage?: "indexeddb" | "memory";
}): Instance;
```

`appId` defaults to the browser hostname. Use lowercase ASCII domain-form names,
1–63 characters.

## Buckets

```ts
instance.getBucket(): Bucket;
instance.createBucket(options: { id: string }): Bucket;
```

- `getBucket()` returns the cached default bucket, whose id is appId.
- `createBucket()` remains available for other buckets. Use a stable domain-shaped id, usually the app host, for
  example `"app.example.com"`.
- Creating a bucket is local-only: no network and no account.
- The local bucket id is the user-facing resource label. Myfield may bind it to
  a different remote bucket id during `connect()`; apps must not assume they
  are the same.
- Valid ids use lowercase `a-z0-9`, `.`, and `-`, max 63 chars.

## Local Object API

Local operations work before `connect()` and never wait for network sync. They
initialize storage lazily; storage errors surface on first use.

```ts
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
  query/search API. Objects from other devices appear once a sync pulls
  them; their `change` event fires after `list()` includes them.
- Object ids and field names starting with `~` are reserved and rejected.

## Instance Key API

| Method | Behavior |
| --- | --- |
| `instance.getKey()` | Return the saved `InstanceKey`, or null. |
| `instance.createKey()` | Generate, save and return an `InstanceKey`. |
| `instance.importKey(key)` | Validate and save an existing key. |
| `instance.removeKey()` | Remove the identity and dependent authorization. |

[`InstanceKey`](../types/index.d.ts) contains instanceId, signing/wrapping public JWKs,
nonextractable private CryptoKeys and createdAt.

| Error | Meaning |
| --- | --- |
| `KEY_EXISTS` | Creation/import found an existing key, including the same ID. |
| `INVALID_STATE` | Key changes require disconnected Instance and Local connections. |
| `INVALID_INSTANCE_KEY` | Damaged records: getKey/connect reject; resume returns disconnected and reports the error through state. |

## Connection API

```ts
instance.resume(options?: { autoSync?: boolean }): Promise<BucketState>;
instance.connect(options?: { autoSync?: boolean }): Promise<BucketState>;
instance.disconnect(): Promise<void>;

bucket.sync(): Promise<void>;
bucket.setAutoSync(enabled: boolean): void;

instance.state; // "disconnected" | "connecting" | "connected"

const offState = instance.on("state", (state, error?) => {});
const offChange = bucket.on("change", (objectId) => {});
```

- Call `resume()` on app boot. It completes pending auth callbacks and restores
  existing authorization without prompting. Concurrent `connect()` waits for it, then
  reuses restored access or starts authorization.
- Call `connect()` from a user gesture. It validates the server session when establishing
  a connection, opening authorization when needed. Already-connected calls reuse access.
- Automatic sync defaults to true. Set `autoSync: false` to stop automatic triggers;
  Local CRUD, manual `bucket.sync()` and Remote requests remain available.
- Browser lifecycle sync is app-owned. Apps may call `bucket.sync()` on focus,
  visibility, or online events.
- `disconnect()` drops this resource's connection and authorization, retaining Local data.

Automatic sync runs while the bucket is connected and auto-sync is enabled. It starts
when connect/resume completes, when the connection becomes active, or on
`setAutoSync(true)`; handle creation alone does no I/O. `connect({ autoSync })` is
shorthand for `setAutoSync()` followed by connecting.

Bucket `resume`/`connect`/`disconnect` manage that bucket's own connection; use them for
buckets from `createBucket()` and Instance methods for the default bucket.
`bucket.connect` also accepts `autoSync` and `authBase`, the full authorization page URL.
Invalid calls reject; authorization failures resolve `"disconnected"` and report the
error through the state event.

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

## Not In V1

- Custom storage adapters.
- Query, pagination, ordering, or full-text search.
- Public subpaths such as `@myfield/sdk/auth` or `@myfield/sdk/bucket`.
- Capability negotiation APIs.
- External KV mutation detection.
- Remote batch or snapshot APIs.
- `setFields()` / `getFields()` as the quickstart path.

## Remote Object API

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance("notes.example.com");
const remote = instance.remote.getBucket();
await instance.resume({ autoSync: false }); // Startup; never prompts.

if (instance.state === "connected") {
  const head = await remote.getCurrent("note:1");
  if (head) {
    const { meta, payload } = await remote.getVersion("note:1", head.versionId);
    console.log(meta.versionId, await payload.arrayBuffer());
  }
}
// Call instance.connect({ autoSync: false }) from your Connect button.
```

`instance.remote.getBucket()` returns the default bucket's Remote handle. Resume or connect before using
it. Missing current objects return null; missing versions throw. `getVersion()`
returns metadata and a payload Response; consume or cancel its body.

`resume()` restores access without prompting. Call `connect()` from a user action
to authorize or recover from `NOT_AUTHORIZED`; network failures never open authorization.
Both return the connection state; `on("state")` reports changes and errors.
`disconnect()` clears shared bucket access and pending requests across tabs,
retaining keys, objects and endpoints.

`commit()` submits app-encoded metadata and encrypted bytes against
`expectedHeadVersionId`; null requests creation. The app owns encryption and merge.

CAS rejection returns `{ok:false, reason}`; other failures throw `ClientError`.
After an uncertain failure, preserve version IDs, bytes and local edits.
All Remote requests support cancellation with `{ signal }` and do not automatically retry.

### Discovery and change hints

| Method | Result |
| --- | --- |
| `getIndex()` | Current heads, nullable `feedCursor`, `hasMoreFeed`. |
| `listFeed({cursor, limit})` | One page of entries, `cursor`, `hasMore`. |
| `getCurrent(id, {knownVersionId})` | Current head with ancestry evidence in `history`. |
| `listVersions(id, versionId, {cursor, limit})` | Metadata plus `history` and `nextCursor`. |
| `watchFeed()` | Resolves after subscription; returns a stream of `{objectId, versionId}` hints. |

Cursors are opaque; null or omitted starts at the beginning. Read feed pages from
`index.feedCursor` while `hasMore`. For `listVersions`, keep the same object/version
anchor and continue until `nextCursor` is null.

With `knownVersionId`, `getCurrent` returns newest-first ancestry evidence: a nonempty
`history` proves ancestry, `[]` means no stored proof, and `null` means incomplete
evidence. `listVersions` lists committed versions, not a complete parent graph.

Await `watchFeed` before catching up the feed. Each hint prompts another catch-up.
Abort or close the stream to stop; it does not reconnect automatically.

```js
const stream = await remote.watchFeed({ signal });
// Catch up the feed before consuming hints.
for await (const hint of stream) {
  console.log(hint.objectId, hint.versionId);
}
```
