# Changelog

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
