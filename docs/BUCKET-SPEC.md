# @myfield/sdk Bucket Spec (v1)

This document is for SDK maintainers and future language-port implementers,
not for app developers using the root `@myfield/sdk` API. It specifies the
encrypted bucket format that SDK versions and compatible ports must reproduce
to read the same local/cloud data. The worker stores ciphertext and validates
transport shape; it does not interpret this plaintext format.

App-facing API semantics live in `docs/API.md`.

## Payload

Plaintext layout before encryption:

```text
byte 0        format version (0x01)
bytes 1..end  UTF-8 JSON body
```

Decoders reject unknown version bytes. Version 1 body is one of:

```jsonc
{
  "t": "lww-map",
  "fields": {
    "<name>": { "v": <json>, "ts": <number>, "actor": "<actorId>" }
  },
  "tombstones": {
    "<name>": { "ts": <number>, "actor": "<actorId>" }
  }
}
```

or:

```jsonc
{ "t": "opaque", "data": <json> }
```

`opaque` is for internal/custom merge strategies. It is not exposed by the
v1 root package facade.

## LWW-Map Merge

Merge is state-based and must be commutative, associative, and idempotent.

1. Union tombstones per field name; keep the max by `(ts, actor)`.
2. Union field entries per field name; keep the max by
   `(ts, actor, serialized v)`.
3. A field entry survives only if it strictly beats the tombstone for the
   same name by `(ts, actor)`. Exact ties delete.

The serialized-value tie-break only keeps malformed duplicate `(ts, actor)`
input deterministic. Normal writers do not emit two values at the same
`(ts, actor)`.

`put()` and `update()` preserve timestamps for JSON-unchanged fields.
Deleting a field writes a tombstone and removes the field entry; rewriting a
field removes its tombstone.

## Clock

Each bucket client has an actor id. Field timestamps use a hybrid clock:

```text
ts = max(local wall clock in ms, max observed ts + 1)
```

Observed timestamps include every field and tombstone in docs the client has
read or merged. This prevents a slow device clock from losing all merges.

## Reserved Object And Field Names

The root package facade reserves app object ids and field names starting with
`~`.

- `~index` is the bucket-maintained encrypted object index used by `list()`
  and new-device restore.
- `~deleted` is the bucket-maintained deleted marker for object tombstones.

Apps cannot write these names through `put()` / `update()` / `delete()`.
Lower-level source modules must preserve the same reservations when used by
facade code.

## Object Id Blinding

Apps address objects by semantic ids. The worker only sees blinded ids:

```text
idKey  = HKDF-SHA-256(
           ikm  = raw 256-bit bucket key,
           salt = "myfield.sdk.v1",
           info = "object-id|" + remoteBucketId
         ) -> HMAC-SHA-256 key

wireId = "ob_" + lowercase-hex(
           HMAC-SHA-256(idKey, utf8(appObjectId))
         )[0..32)
```

`remoteBucketId` is `bucketAccessGrant.envelope.bucketId`, not necessarily
the app-local `createBucket({ id })` label.

The mapping is deterministic for every authorized device and one-way for the
platform. The semantic app object id must not be sent in URL paths, headers,
or plaintext metadata.

## Encryption Envelope

Object payloads use the established bucket sync envelope shape:

- AES-GCM-256 with the bucket payload key.
- 96-bit random IV per write.
- AAD: `myfield.bucket.sync.v1|<remoteBucketId>|<wireObjectId>`.
- Envelope JSON fields:
  - `ciphertext`
  - `cipherMeta { alg, iv, keyId, bucketId, aad }`
  - `wrappedDEK`
  - `wrappedDEKMeta { alg, keyId, bucketId }`

The SDK uses direct-bucket-key mode: `wrappedDEK` is the key id and
`wrappedDEKMeta.alg` is `"direct-bucket-key"`.

Worker-visible version metadata is transport metadata only. LWW timestamps,
field names, object semantics, and app metadata live inside ciphertext.

## Bucket Keys

The authorization callback provides a bucket access grant. Its envelope wraps
a raw 256-bit bucket key to the instance wrapping key using ECDH P-256,
HKDF-SHA-256, and AES-GCM-256.

The SDK derives:

- payload key: raw key imported as non-extractable AES-GCM-256 key.
- object-id key: HKDF/HMAC key described above.

Raw key bytes are zeroed after derivation.

## Sync Behavior Relevant To Format

The worker is a relay, not a database/query engine. It does not list objects
or interpret bucket indexes. The SDK sync loop is:

```text
pull current -> merge with local -> CAS push
```

On CAS conflict, the SDK pulls the current remote payload, merges, and
retries. On remote miss with surviving local state, the SDK re-creates the
object. The internal `~index` object has the same weak relay/eviction
semantics as every other object; dangling index entries are tolerated and
read as absent data.
