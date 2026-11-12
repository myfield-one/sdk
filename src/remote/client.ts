import { ClientError } from "../errors.ts";
import { createBucketClient, type RemoteBucket } from "./bucket.ts";
import { createHttpRequest, isRecord, requireString, type RemoteRequest } from "./http.ts";

export type RemoteClientOptions = {
  apiBase: string;
  mfid: string;
  bucketId: string;
  getCredential(): { token: string } | Promise<{ token: string }>;
  fetch?: typeof globalThis.fetch;
};

export type RemoteClient = { getBucket(): RemoteBucket };

export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
  if (!isRecord(options)) throw new ClientError("INVALID_INPUT", "Client options are required");
  const httpRequest = createHttpRequest(options);
  const { mfid, bucketId, getCredential } = options;
  requireString(mfid, "mfid");
  if (typeof getCredential !== "function") throw new ClientError("INVALID_INPUT", "getCredential must be a function");

  const request: RemoteRequest = async (path, init = {}) => {
    init.signal?.throwIfAborted();
    const credential = await getCredential();
    requireString(credential?.token, "token");
    init.signal?.throwIfAborted();
    let headers: Headers;
    try {
      headers = new Headers(init.headers);
      headers.set("x-myfield-mfid", mfid);
      headers.set("authorization", `Bearer ${credential.token}`);
    } catch (cause) { throw new ClientError("INVALID_INPUT", "Invalid request headers", { cause }); }
    return httpRequest(path, { ...init, headers });
  };

  const bucket = createBucketClient(request, bucketId);
  return { getBucket: () => bucket };
}
