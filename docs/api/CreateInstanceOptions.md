[@myfield/sdk](index.md) / CreateInstanceOptions

# Type Alias: CreateInstanceOptions

> **CreateInstanceOptions** = `object`

Local persistence scope and authorization page settings. Creating an Instance does not connect.

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="namespace"></a> `namespace?` | `string` | Existing local storage scope; defaults to explicit appId, otherwise "default". |
| <a id="storage"></a> `storage?` | `"indexeddb"` \| `"memory"` | IndexedDB by default; memory is useful for tests and ephemeral clients. |
| <a id="appid"></a> `appId?` | `string` | Stable lowercase domain-form application ID; defaults to the browser hostname. |
| <a id="authurl"></a> `authUrl?` | `string` | Absolute HTTP(S) Auth page URL without credentials, query or fragment. |
