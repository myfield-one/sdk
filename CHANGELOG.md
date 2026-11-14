# Changelog

## 0.9.2-alpha.1 (unreleased)

- Fix `connect()` racing startup `resume()`, including custom authorization URLs and cancellation.
- Unify Local and Remote connections, add `instance.getBucket()` and optional auto-sync
  control on connect/resume. Keep manual sync available and validate legacy upload ACKs.
- Breaking: legacy `bucket.connect({ authBase })` no longer appends `/auth/` or infers
  API hosts; pass the full authorization page URL. The API address comes from the grant.
- Fixed Local sync marking a write synchronized when the server answered HTTP 200 with
  `{ ok: false }`; unauthorized acknowledgements now invalidate access.
- Automatic sync now follows connection state and `setAutoSync()` without requiring
  `ready()` or prior Local operations. `bucket.ready()` is a deprecated no-op.
- Sync error details keep the original retry information (`retryable`, `retryAfterMs`).
- Add appId initialization and Instance key read/create/import/removal with nonextractable keys.
  String initialization now means appId, which scopes identity and default storage;
  namespace overrides storage scope.
  Invalid identities remain intact for explicit recovery; Local objects are retained.
- Separate instance key, proof and session internals; preserve APIs and stored records.
  Derive instance IDs from public key material only.
- Add Remote index/feed queries, paged version history, ancestry evidence and
  change notifications.
- Add Instance `resume()`, `connect()`, `disconnect()` and state events, plus
  `instance.remote.getBucket()` for remote reads and CAS commits without Local sync.
- Add `ClientError` and request cancellation. CAS rejection returns a result;
  uncertain acknowledgements throw. Remote requests never retry automatically.
- Accept lowercase domain-form appIds up to 63 characters.
  Existing initialization, storage and formats remain compatible. Local and Remote
  access to the same bucket require separate Instances.

## 0.9.1

- Sync uses the relay's object index; `~index` is no longer pushed.
- Fixed a second write in the same millisecond not reaching other devices.

## 0.9.0

First public release.

- `createInstance()` / `instance.createBucket({ id })` public facade with
  local-first `put`/`get`/`update`/`delete`/`list` object CRUD.
- Instance auth: `connect()` / `disconnect()`, popup and same-tab (iOS)
  authorization flows against `https://myfield.one/auth/`, alias-only
  pairwise identity, callback envelope decryption, bearer session refresh,
  and the unauthorized-to-disconnected transition.
- Bucket sync: three-route CAS transport, deterministic object-id blinding,
  encrypted field-map (LWW) payload format with tombstones and a hybrid
  clock, pluggable merge strategies, IndexedDB and memory storage adapters.
- Sync triggers: launch/resume, post-write debounce, and a timer fallback;
  browser lifecycle sync (focus/visibility) is left to the app.
- `docs/BUCKET-SPEC.md` format reference (payload layout, merge rules, id
  derivation).
