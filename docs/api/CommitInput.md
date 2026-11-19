[@myfield/sdk](index.md) / CommitInput

# Type Alias: CommitInput

> **CommitInput** = `object`

App-encrypted bytes and metadata submitted against an expected remote head.

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="meta"></a> `meta` | [`VersionMeta`](VersionMeta.md) | - |
| <a id="payload"></a> `payload` | `Blob` \| `Uint8Array` | App-encrypted payload; never submit private plaintext. |
| <a id="expectedheadversionid"></a> `expectedHeadVersionId` | `string` \| `null` | Last observed head, or null to create an object. |
