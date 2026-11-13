// @myfield/sdk — Myfield open SDK.
//
// The mental model for apps: a bucket is a local-first end-to-end-encrypted
// object KV with CAS-backed sync. Local CRUD needs no account and no
// network; connect() is the single network/identity boundary. The cloud is
// a sync relay, not a backup — objects may be missing in cloud (old data
// rotates out), uploads may transiently fail (rate limits), and local
// storage is the source of truth. See docs/API.md.

export {
  createInstance,
  type Bucket,
  type BinaryInput,
  type BinaryOptions,
  type BucketBinaryValue,
  type BucketState,
  type ConnectOptions,
  type CreateInstanceOptions,
  type Instance,
  type ListEntry,
} from "./facade.ts";
export { NotConnectedError } from "./errors.ts";
export { OfflineError } from "./bucket/transport.ts";
export type { RemoteBucket, VersionMeta, CurrentVersion, ObjectVersion, CommitInput, CommitResult,
  PageOptions, VersionHistory, FeedHint, FeedPage, BucketIndex } from "./remote/bucket.ts";
export type { RequestOptions } from "./remote/http.ts";
export { ClientError } from "./errors.ts";
export type { ClientErrorOptions } from "./errors.ts";
