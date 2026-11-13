import { ClientError } from "../errors.ts";
import { bytesToB64url, utf8Encode } from "../internal/encoding.ts";
import { invalidResponse, readJson, isRecord, requireString, type RemoteRequest, type RequestOptions } from "./http.ts";
import { openFeedStream, isFeedHint, type FeedHint } from "./feed.ts";
export type { FeedHint } from "./feed.ts";

export type VersionMeta = {
  objectId: string;
  versionId: string;
  parentVersionIds: string[];
  payloadHash?: string;
  [field: string]: unknown;
};

export type CurrentVersion = {
  versionId: string;
  headVersionMeta: VersionMeta;
  history?: string[] | null;
  [field: string]: unknown;
};

export type ObjectVersion<TPayload = Response> = { meta: VersionMeta; payload: TPayload };
export type CommitInput = { meta: VersionMeta; payload: Blob | Uint8Array; expectedHeadVersionId: string | null };
export type CommitResult = { ok: true } | { ok: false; reason: "version-mismatch" | "conflict" };
export type PageOptions = RequestOptions & { cursor?: string | null; limit?: number };
export type VersionHistory = VersionMeta & { history: string[]; nextCursor: string | null };
export type FeedPage = { entries: FeedHint[]; cursor: string; hasMore: boolean; [field: string]: unknown };
export type BucketIndex = { bucketId: string; objects: FeedHint[]; feedCursor: string | null; hasMoreFeed: boolean; [field: string]: unknown };

export interface RemoteBucket {
  getCurrent(objectId: string, options?: RequestOptions & { knownVersionId?: string | null }): Promise<CurrentVersion | null>;
  getVersion(objectId: string, versionId: string, options?: RequestOptions): Promise<ObjectVersion>;
  getVersionMeta(objectId: string, versionId: string, options?: RequestOptions): Promise<VersionMeta>;
  getPayload(objectId: string, versionId: string, options?: RequestOptions): Promise<Response>;
  commit(input: CommitInput, options?: RequestOptions): Promise<CommitResult>;
  listVersions(objectId: string, versionId: string, options?: PageOptions): Promise<VersionHistory>;
  getIndex(options?: RequestOptions): Promise<BucketIndex>;
  listFeed(options?: PageOptions): Promise<FeedPage>;
  watchFeed(options?: RequestOptions): Promise<AsyncGenerator<FeedHint>>;
}

function isHistory(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0)
    && new Set(value).size === value.length;
}

function pageQuery(options: PageOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.cursor != null) {
    if (typeof options.cursor !== "string") throw new ClientError("INVALID_INPUT", "cursor must be a string or null");
    if (options.cursor) query.set("cursor", options.cursor);
  }
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new ClientError("INVALID_INPUT", "limit must be a positive integer");
    query.set("limit", String(options.limit));
  }
  return query;
}

function isVersionMeta(value: unknown, objectId: string, versionId?: string): value is VersionMeta {
  return isRecord(value) && value.objectId === objectId
    && typeof value.versionId === "string" && value.versionId.length > 0
    && (versionId === undefined || value.versionId === versionId)
    && Array.isArray(value.parentVersionIds)
    && value.parentVersionIds.every(id => typeof id === "string" && id.length > 0);
}

function segment(id: string): string {
  requireString(id, "ID");
  if (id === "." || id === "..") throw new ClientError("INVALID_INPUT", "Dot segments cannot be requested");
  return encodeURIComponent(id);
}

function writableId(id: string): void {
  requireString(id, "ID");
  if (id === "." || id.includes("..")) throw new ClientError("INVALID_INPUT", "Dot-segment IDs cannot be committed");
}

export function createBucketClient(request: RemoteRequest, bucketId: string): RemoteBucket {
  const root = `/v1/api/sync/buckets/${segment(bucketId)}`;
  const objectPath = (id: string) => `${root}/objects/${segment(id)}`;
  const versionPath = (id: string, versionId: string) => `${objectPath(id)}/versions/${segment(versionId)}`;
  async function json(path: string, options: RequestOptions) {
    const response = await request(path, { signal: options.signal });
    return { response, body: await readJson(response, options.signal) };
  }
  async function getVersionMeta(objectId: string, versionId: string, options: RequestOptions = {}): Promise<VersionMeta> {
    const { response, body } = await json(`${versionPath(objectId, versionId)}/meta`, options);
    if (!isVersionMeta(body, objectId, versionId)) throw invalidResponse(response);
    return body;
  }
  return {
    async getCurrent(objectId, options = {}) {
      const query = new URLSearchParams({ miss: "null" });
      if (options.knownVersionId != null) { requireString(options.knownVersionId, "knownVersionId"); query.set("have", options.knownVersionId); }
      const { response, body } = await json(`${objectPath(objectId)}/current?${query}`, options);
      if (body.versionId === null && body.headVersionMeta === null) return null;
      if (typeof body.versionId !== "string" || !isVersionMeta(body.headVersionMeta, objectId, body.versionId)) throw invalidResponse(response);
      if (options.knownVersionId != null && !Object.hasOwn(body, "history")) throw invalidResponse(response, "Missing history evidence");
      if (Object.hasOwn(body, "history") && body.history !== null) {
        if (!isHistory(body.history)) throw invalidResponse(response);
        if (body.history.length && (body.history[0] !== body.versionId
          || (options.knownVersionId != null && body.history.at(-1) !== options.knownVersionId))) throw invalidResponse(response);
      }
      return body as CurrentVersion;
    },
    getVersionMeta,
    async listVersions(objectId, versionId, options = {}) {
      const query = pageQuery(options);
      query.set("history", "full");
      const { response, body } = await json(`${versionPath(objectId, versionId)}/meta?${query}`, options);
      if (!isVersionMeta(body, objectId, versionId) || !isHistory(body.history)
        || (!query.has("cursor") && body.history[0] !== versionId)
        || !(body.nextCursor === null || (typeof body.nextCursor === "string" && body.nextCursor.length > 0))) throw invalidResponse(response);
      return body as VersionHistory;
    },
    async getIndex(options = {}) {
      const { response, body } = await json(`${root}/objects:index`, options);
      if (body.bucketId !== bucketId || !Array.isArray(body.objects) || !body.objects.every(isFeedHint)
        || !(body.feedCursor === null || typeof body.feedCursor === "string")
        || typeof body.hasMoreFeed !== "boolean") throw invalidResponse(response);
      return body as BucketIndex;
    },
    async listFeed(options = {}) {
      const query = pageQuery(options);
      const { response, body } = await json(`${root}/feed${query.size ? `?${query}` : ""}`, options);
      if (!Array.isArray(body.entries) || !body.entries.every(isFeedHint)
        || typeof body.cursor !== "string" || typeof body.hasMore !== "boolean") throw invalidResponse(response);
      return body as FeedPage;
    },
    async watchFeed(options = {}) {
      const response = await request(`${root}/feed/stream`, { headers: { accept: "text/event-stream" }, signal: options.signal });
      return openFeedStream(response, options.signal);
    },
    async getPayload(objectId, versionId, options = {}) {
      return request(`${versionPath(objectId, versionId)}/payload`, { signal: options.signal });
    },
    async getVersion(objectId, versionId, options = {}) {
      const path = versionPath(objectId, versionId);
      let payload: Response | undefined;
      let failed = false;
      const download = request(`${path}/payload`, { signal: options.signal }).then(response => {
        if (failed) void response.body?.cancel().catch(() => {});
        else payload = response;
        return response;
      });
      try {
        const [meta, response] = await Promise.all([getVersionMeta(objectId, versionId, options), download]);
        return { meta, payload: response };
      } catch (error) {
        failed = true;
        void payload?.body?.cancel().catch(() => {});
        throw error;
      }
    },
    async commit(input, options = {}) {
      if (!isRecord(input) || !isRecord(input.meta)) throw new ClientError("INVALID_INPUT", "Commit metadata is required");
      if (input.expectedHeadVersionId !== null) requireString(input.expectedHeadVersionId, "expectedHeadVersionId");
      writableId(input.meta.objectId);
      writableId(input.meta.versionId);
      if (!(input.payload instanceof Blob) && !(input.payload instanceof Uint8Array)) throw new ClientError("INVALID_INPUT", "Payload must be a Blob or Uint8Array");
      let headers: Headers;
      try {
        headers = new Headers({ "content-type": "application/octet-stream",
          "x-myfield-version-meta": bytesToB64url(utf8Encode(JSON.stringify(input.meta))) });
        if (input.expectedHeadVersionId !== null) headers.set("x-myfield-expected-head-version-id", input.expectedHeadVersionId);
      } catch (cause) { throw new ClientError("INVALID_INPUT", "Invalid commit metadata or CAS header", { cause }); }
      const response = await request(objectPath(input.meta.objectId), { method: "POST", headers, body: input.payload as BodyInit, signal: options.signal });
      const body = await readJson(response, options.signal);
      if (body.ok === true) return body as CommitResult;
      if (body.ok === false && (body.reason === "version-mismatch" || body.reason === "conflict")) return body as CommitResult;
      throw invalidResponse(response, "Invalid commit result");
    },
  };
}
