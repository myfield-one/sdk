import {
  createInstance, ClientError,
  type CreateInstanceOptions, type RemoteBucket, type CurrentVersion, type VersionMeta,
  type ObjectVersion, type CommitInput, type CommitResult, type RequestOptions, type ClientErrorOptions,
} from "../types/index.js";
import type * as Source from "../src/index.ts";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type DeclarationParity = [
  Assert<Same<CreateInstanceOptions, Source.CreateInstanceOptions>>,
  Assert<Same<ReturnType<typeof createInstance>["resume"], Source.Instance["resume"]>>,
  Assert<Same<ReturnType<typeof createInstance>["connect"], Source.Instance["connect"]>>,
  Assert<Same<ReturnType<typeof createInstance>["on"], Source.Instance["on"]>>,
  Assert<Same<RemoteBucket, Source.RemoteBucket>>,
  Assert<Same<VersionMeta, Source.VersionMeta>>,
  Assert<Same<CurrentVersion, Source.CurrentVersion>>,
  Assert<Same<ObjectVersion, Source.ObjectVersion>>,
  Assert<Same<CommitInput, Source.CommitInput>>,
  Assert<Same<CommitResult, Source.CommitResult>>,
  Assert<Same<RequestOptions, Source.RequestOptions>>,
  Assert<Same<ClientErrorOptions, Source.ClientErrorOptions>>,
  Assert<Same<ClientError, Source.ClientError>>,
];

const instance = createInstance("notes.example.com");
// @ts-expect-error The Instance API uses the default authorization URL.
createInstance("notes.example.com", { authUrl: "https://example.com/auth/" });
// @ts-expect-error No Instance disposal API is exposed.
instance.dispose();
const remote: RemoteBucket = instance.remote.getBucket();
const resumed: "disconnected" | "connecting" | "connected" = await instance.resume();
const stopState = instance.on("state", (state, error) => {
  console.log(state, error?.code);
});
const connected: "disconnected" | "connecting" | "connected" = await instance.connect();
stopState();
// @ts-expect-error State is read-only.
instance.state = "connected";
// @ts-expect-error Select storage using the object form, not a second argument.
createInstance("notes.example.com", { storage: "memory" });
// @ts-expect-error The Instance API does not accept an authorization address.
instance.connect({ authBase: "https://example.com/auth/" });
const signal = new AbortController().signal;
const head: CurrentVersion | null = await remote.getCurrent("note", { signal });
if (head) {
  const version: ObjectVersion = await remote.getVersion("note", head.versionId, { signal });
  await version.payload.arrayBuffer();
}
const meta: VersionMeta = { objectId: "note", versionId: "next", parentVersionIds: [], extension: true };
const version: ObjectVersion<Uint8Array> = { meta, payload: new Uint8Array([42]) };
const result: CommitResult = await remote.commit({ ...version, expectedHeadVersionId: null }, { signal });
if (!result.ok) { const reason: "version-mismatch" | "conflict" = result.reason; void reason; }
// @ts-expect-error CAS must be explicit.
void remote.commit(version);
// @ts-expect-error History is a later batch.
void remote.getCurrent("note", { have: "old" });
// @ts-expect-error Feed is a later batch.
void remote.watchFeed();
const bucket = createInstance({ namespace: "existing", storage: "memory" }).createBucket({ id: "app.example.com" });
await bucket.ready(); await bucket.put("note", { text: "existing" });
bucket.on("state", state => console.log(state));
