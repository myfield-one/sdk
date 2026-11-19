[@myfield/sdk](index.md) / BucketBinaryValue

# Type Alias: BucketBinaryValue

> **BucketBinaryValue** = `object`

A binary field handle. Read bytes explicitly through its asynchronous methods.

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="kind"></a> `kind` | `readonly` | `"binary"` |
| <a id="size"></a> `size` | `readonly` | `number` |
| <a id="mimetype"></a> `mimeType?` | `readonly` | `string` |
| <a id="name"></a> `name?` | `readonly` | `string` |
| <a id="lastmodified"></a> `lastModified?` | `readonly` | `number` |

## Methods

### blob()

> **blob**(): `Promise`\<`Blob`\>

#### Returns

`Promise`\<`Blob`\>

***

### arrayBuffer()

> **arrayBuffer**(): `Promise`\<`ArrayBuffer`\>

#### Returns

`Promise`\<`ArrayBuffer`\>
