[@myfield/sdk](index.md) / Bucket

# Type Alias: Bucket

> **Bucket** = `object`

Local-first object storage. Network synchronization requires a connection.

## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="id"></a> `id` | `readonly` | `string` | The local resource label; the granted remote bucket ID may differ. |
| <a id="state"></a> `state` | `readonly` | [`BucketState`](BucketState.md) | Current connection state. |

## Methods

### binary()

> **binary**(`input`, `options?`): [`BucketBinaryValue`](BucketBinaryValue.md)

Wraps a binary field without uploading it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`BinaryInput`](BinaryInput.md) \| [`BucketBinaryValue`](BucketBinaryValue.md) |
| `options?` | [`BinaryOptions`](BinaryOptions.md) |

#### Returns

[`BucketBinaryValue`](BucketBinaryValue.md)

***

### ~~ready()~~

> **ready**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Deprecated

No-op kept for compatibility; operations initialize storage lazily.

***

### put()

> **put**(`objectId`, `object`): `Promise`\<`void`\>

Replaces known local fields; concurrent unknown remote fields remain mergeable.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `object` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`objectId`): `Promise`\<`Record`\<`string`, `unknown`\> \| `null`\>

Reads local data, returning null for absent or deleted objects.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\> \| `null`\>

***

### update()

> **update**(`objectId`, `fields`): `Promise`\<`void`\>

Updates top-level fields; undefined deletes a field.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `fields` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

### delete()

> **delete**(`objectId`): `Promise`\<`void`\>

Creates a local deletion and schedules synchronization when connected.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### list()

> **list**(`options?`): `Promise`\<[`ListEntry`](ListEntry.md)[]\>

Lists known local objects newest first; does not query the cloud.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `prefix?`: `string`; `includeDeleted?`: `boolean`; \} |
| `options.prefix?` | `string` |
| `options.includeDeleted?` | `boolean` |

#### Returns

`Promise`\<[`ListEntry`](ListEntry.md)[]\>

***

### resume()

> **resume**(): `Promise`\<[`BucketState`](BucketState.md)\>

Restores saved authorization without prompting. Load local data first.

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### connect()

> **connect**(`options?`): `Promise`\<[`BucketState`](BucketState.md)\>

Connects from a user gesture; authorization failures report disconnected state.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`ConnectOptions`](ConnectOptions.md) |

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### disconnect()

> **disconnect**(): `Promise`\<`void`\>

Drops authorization and connection while retaining local objects and identity keys.

#### Returns

`Promise`\<`void`\>

***

### sync()

> **sync**(): `Promise`\<`void`\>

Runs one Local sync pass; rejects when disconnected.

#### Returns

`Promise`\<`void`\>

***

### setAutoSync()

> **setAutoSync**(`enabled`): `void`

Enables or disables automatic Local sync; an active pass may finish.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `enabled` | `boolean` |

#### Returns

`void`

***

### on()

#### Call Signature

> **on**(`event`, `handler`): () => `void`

Subscribes to state or local changes; returns an unsubscribe function.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"state"` |
| `handler` | (`state`, `detail?`) => `void` |

##### Returns

() => `void`

#### Call Signature

> **on**(`event`, `handler`): () => `void`

Subscribes to state or local changes; returns an unsubscribe function.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"change"` |
| `handler` | (`objectId`) => `void` |

##### Returns

() => `void`

***

### dispose()

> **dispose**(): `void`

Stops this bucket runtime and releases listeners and sync resources.

#### Returns

`void`
