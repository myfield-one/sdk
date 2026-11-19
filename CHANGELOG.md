# Changelog

## 0.9.3-alpha.0

### Changed
- Generate public declarations, API review reports and Markdown references from source.
- Organize documentation into README, the existing API guide, generated API Reference and Specification.
- Correct the documented existing binary payload framing; runtime APIs and formats are unchanged.

## 0.9.2

### Added
- Unified Instance APIs for connection, state events and Local bucket access,
  with optional automatic sync.
- Remote APIs for object reads, CAS commits, version history and feed notifications,
  including bucket-key access for app-managed encryption.
- Instance key creation, retrieval, import and removal.

### Fixed
- Connection races during startup and incorrect upload-success handling.

### Compatibility
- String initialization now means `appId`; use `namespace` to preserve an existing
  storage scope.
- Configure authorization with `createInstance({ authUrl })` instead of
  `bucket.connect({ authBase })`.
- `bucket.ready()` is now a deprecated no-op. Existing stored keys and Local data
  formats remain supported.

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
