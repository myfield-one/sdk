[@myfield/sdk](index.md) / Instance

# Type Alias: Instance

> **Instance** = `object`

Application identity, authorization and access to Local and Remote buckets.

## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="namespace"></a> `namespace` | `readonly` | `string` | Local persistence namespace; never sent as the remote bucket ID. |
| <a id="remote"></a> `remote` | `readonly` | `object` | Remote access for the default bucket; the app owns encryption and local storage. |
| `remote.getBucket` | `public` | () => [`RemoteBucket`](RemoteBucket.md) | - |
| <a id="state"></a> `state` | `readonly` | [`BucketState`](BucketState.md) | Current connection state. |

## Methods

### getBucket()

> **getBucket**(): [`Bucket`](Bucket.md)

Returns the cached default Local bucket identified by appId.

#### Returns

[`Bucket`](Bucket.md)

***

### getKey()

> **getKey**(): `Promise`\<[`InstanceKey`](InstanceKey.md) \| `null`\>

Reads the saved instance identity, or null when absent.

#### Returns

`Promise`\<[`InstanceKey`](InstanceKey.md) \| `null`\>

***

### createKey()

> **createKey**(): `Promise`\<[`InstanceKey`](InstanceKey.md)\>

Creates an identity when disconnected; rejects if a key already exists.

#### Returns

`Promise`\<[`InstanceKey`](InstanceKey.md)\>

***

### importKey()

> **importKey**(`key`): `Promise`\<`void`\>

Validates and saves an identity when disconnected; does not import grants.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | [`InstanceKey`](InstanceKey.md) |

#### Returns

`Promise`\<`void`\>

***

### removeKey()

> **removeKey**(): `Promise`\<`void`\>

Removes the identity and dependent authorization when disconnected.

#### Returns

`Promise`\<`void`\>

***

### resume()

> **resume**(`options?`): `Promise`\<[`BucketState`](BucketState.md)\>

Restores saved authorization without prompting. Load local data first.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `autoSync?`: `boolean`; \} |
| `options.autoSync?` | `boolean` |

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### connect()

> **connect**(`options?`): `Promise`\<[`BucketState`](BucketState.md)\>

Connects from a user gesture; authorization failures report disconnected state.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `autoSync?`: `boolean`; \} |
| `options.autoSync?` | `boolean` |

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### disconnect()

> **disconnect**(): `Promise`\<`void`\>

Drops authorization and connection while retaining local objects and identity keys.

#### Returns

`Promise`\<`void`\>

***

### on()

> **on**(`event`, `handler`): () => `void`

Subscribes to connection state and error notifications; returns an unsubscribe function.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"state"` |
| `handler` | (`state`, `error?`) => `void` |

#### Returns

() => `void`

***

### createBucket()

> **createBucket**(`options`): [`Bucket`](Bucket.md)

Gets a Local handle for another stable resource label; creation is local-only.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `id`: `string`; \} |
| `options.id` | `string` |

#### Returns

[`Bucket`](Bucket.md)
