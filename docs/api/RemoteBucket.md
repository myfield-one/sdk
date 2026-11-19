[@myfield/sdk](index.md) / RemoteBucket

# Interface: RemoteBucket

Storage-independent Remote operations. The application owns payload encryption, merge and recovery.

## Methods

### getBucketKey()

> **getBucketKey**(`options?`): `Promise`\<[`BucketKey`](BucketKey.md)\>

Returns the granted key handle without a request. Use your own AAD and retain keyId.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`BucketKey`](BucketKey.md)\>

***

### getCurrent()

> **getCurrent**(`objectId`, `options?`): `Promise`\<[`CurrentVersion`](CurrentVersion.md) \| `null`\>

Reads the current head, or null when absent. knownVersionId requests ancestry evidence.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) & `object` |

#### Returns

`Promise`\<[`CurrentVersion`](CurrentVersion.md) \| `null`\>

***

### getVersion()

> **getVersion**(`objectId`, `versionId`, `options?`): `Promise`\<[`ObjectVersion`](ObjectVersion.md)\<`Response`\>\>

Reads metadata and a payload Response; consume or cancel its body.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`ObjectVersion`](ObjectVersion.md)\<`Response`\>\>

***

### getVersionMeta()

> **getVersionMeta**(`objectId`, `versionId`, `options?`): `Promise`\<[`VersionMeta`](VersionMeta.md)\>

Reads metadata for one committed version; missing versions throw.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`VersionMeta`](VersionMeta.md)\>

***

### getPayload()

> **getPayload**(`objectId`, `versionId`, `options?`): `Promise`\<`Response`\>

Returns the encrypted payload Response; consume or cancel its body.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<`Response`\>

***

### commit()

> **commit**(`input`, `options?`): `Promise`\<[`CommitResult`](CommitResult.md)\>

Submits encrypted bytes with CAS. Preserve IDs and bytes after uncertain failures.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`CommitInput`](CommitInput.md) |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`CommitResult`](CommitResult.md)\>

***

### listVersions()

> **listVersions**(`objectId`, `versionId`, `options?`): `Promise`\<[`VersionHistory`](VersionHistory.md)\>

Reads committed-version history anchored at one object/version; follow nextCursor.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`PageOptions`](PageOptions.md) |

#### Returns

`Promise`\<[`VersionHistory`](VersionHistory.md)\>

***

### getIndex()

> **getIndex**(`options?`): `Promise`\<[`BucketIndex`](BucketIndex.md)\>

Reads the current heads snapshot and its feed catch-up cursor.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`BucketIndex`](BucketIndex.md)\>

***

### listFeed()

> **listFeed**(`options?`): `Promise`\<[`FeedPage`](FeedPage.md)\>

Reads a feed page; continue from cursor while hasMore is true.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`PageOptions`](PageOptions.md) |

#### Returns

`Promise`\<[`FeedPage`](FeedPage.md)\>

***

### watchFeed()

> **watchFeed**(`options?`): `Promise`\<`AsyncGenerator`\<[`FeedHint`](FeedHint.md), `any`, `unknown`\>\>

Awaits subscription readiness and yields hints. Catch up after subscribing; no automatic reconnect.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<`AsyncGenerator`\<[`FeedHint`](FeedHint.md), `any`, `unknown`\>\>
