[@myfield/sdk](index.md) / VersionMeta

# Type Alias: VersionMeta

> **VersionMeta** = `object`

Transport metadata. Application plaintext and private metadata must remain encrypted.

## Indexable

> \[`field`: `string`\]: `unknown`

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="objectid"></a> `objectId` | `string` | App-supplied Remote object ID; Remote does not apply Local ID blinding. |
| <a id="versionid"></a> `versionId` | `string` | Fixed version identity; reuse it with the same bytes after an uncertain outcome. |
| <a id="parentversionids"></a> `parentVersionIds` | `string`[] | Direct parents; include the expected CAS head for an update. |
| <a id="payloadhash"></a> `payloadHash?` | `string` | SHA-256 of the submitted ciphertext bytes when supplied. |
