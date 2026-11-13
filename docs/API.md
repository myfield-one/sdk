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

## `createInstance`

```ts
createInstance(namespace: string): Instance;
createInstance(options?: {
  namespace?: string;
  storage?: "indexeddb" | "memory";
}): Instance;
```

Defaults: namespace `"default"`, IndexedDB at `myfield-sdk:${namespace}` / `kv`.
Use lowercase ASCII domain labels, at most 63 characters total. Keep existing names
for data and 0.9.1 compatibility. The object form trims whitespace and also supports
memory storage.

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
  query/search API. Objects from other devices appear once a sync pulls
  them; their `change` event fires after `list()` includes them.
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
- Remote batch or snapshot APIs.
- `setFields()` / `getFields()` as the quickstart path.

## Remote Object API

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance("notes.example.com");
const remote = instance.remote.getBucket();
await instance.resume(); // Startup; never prompts.

if (instance.state === "connected") {
  const head = await remote.getCurrent("note:1");
  if (head) {
    const { meta, payload } = await remote.getVersion("note:1", head.versionId);
    console.log(meta.versionId, await payload.arrayBuffer());
  }
}
// Call instance.connect() from your Connect button.
```

`getBucket()` returns the namespace's Remote handle. Resume or connect before using
it. Missing current objects return null; missing versions throw. `getVersion()`
returns metadata and a payload Response; consume or cancel its body.

`resume()` restores access without prompting. Call `connect()` from a user action
to authorize or recover from `NOT_AUTHORIZED`; network failures never open authorization.
Both return the connection state; `on("state")` reports changes and errors.
`disconnect()` clears shared bucket access and pending requests across tabs,
retaining keys, objects and endpoints.
Remote operations do not start Local sync.

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
