[@myfield/sdk](index.md) / BucketIndex

# Type Alias: BucketIndex

> **BucketIndex** = `object`

Current object heads and the starting cursor for feed catch-up.

## Indexable

> \[`field`: `string`\]: `unknown`

## Properties

| Property | Type |
| ------ | ------ |
| <a id="bucketid"></a> `bucketId` | `string` |
| <a id="objects"></a> `objects` | [`FeedHint`](FeedHint.md)[] |
| <a id="feedcursor"></a> `feedCursor` | `string` \| `null` |
| <a id="hasmorefeed"></a> `hasMoreFeed` | `boolean` |
