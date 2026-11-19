[@myfield/sdk](index.md) / createInstance

# Function: createInstance()

## Call Signature

> **createInstance**(`appId`): [`Instance`](Instance.md)

Creates a local Instance with an explicit application ID. No network I/O.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `appId` | `string` |

### Returns

[`Instance`](Instance.md)

## Call Signature

> **createInstance**(`options?`): [`Instance`](Instance.md)

Creates a local Instance; appId defaults to the browser hostname.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`CreateInstanceOptions`](CreateInstanceOptions.md) |

### Returns

[`Instance`](Instance.md)
