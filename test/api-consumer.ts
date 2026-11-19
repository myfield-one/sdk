import { createInstance, ClientError, type BucketBinaryValue } from "@myfield/sdk";

const instance = createInstance({ appId: "consumer.example", storage: "memory" });
const bucket = instance.getBucket();
void bucket.put("file:1", { content: bucket.binary(new Uint8Array([1, 2])) });
const value: BucketBinaryValue = bucket.binary(new Blob(["hello"]));
void value.arrayBuffer();
instance.on("state", (_state, error) => {
  if (error instanceof ClientError) console.debug(error.requestId, error.retryAfterMs);
});
// @ts-expect-error Internal transport hooks are excluded from the public entry.
bucket.__bindTestTransport({});
// @ts-expect-error The prototype's migration entry is not a public export.
void import("@myfield/sdk/migration");
// @ts-expect-error Prototype merge strategies are not a public option.
createInstance({ appId: "consumer.example", mergeStrategy: {} });
// @ts-expect-error Internal source modules are not package subpaths.
void import("@myfield/sdk/src/facade.ts");
