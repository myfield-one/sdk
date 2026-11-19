import { ClientError } from "../errors.ts";
import { bytesToB64url, utf8Encode } from "../internal/encoding.ts";
import { invalidResponse, readJson, isRecord, requireString, type RemoteRequest, type RequestOptions } from "./http.ts";
import { openFeedStream, isFeedHint, type FeedHint } from "./feed.ts";
export type { FeedHint } from "./feed.ts";

/** Transport metadata. Application plaintext and private metadata must remain encrypted.
 * @public
 */
export type VersionMeta = {
  /** App-supplied Remote object ID; Remote does not apply Local ID blinding. */
  objectId: string;
  /** Fixed version identity; reuse it with the same bytes after an uncertain outcome. */
  versionId: string;
  /** Direct parents; include the expected CAS head for an update. */
  parentVersionIds: string[];
  /** SHA-256 of the submitted ciphertext bytes when supplied. */
  payloadHash?: string;
  [field: string]: unknown;
};

/** The current committed version, with optional newest-first ancestry evidence.
 * @public
 */
export type CurrentVersion = {
  versionId: string;
  headVersionMeta: VersionMeta;
  history?: string[] | null;
  [field: string]: unknown;
};

/** Version metadata and its payload. Consume or cancel Response bodies.
 * @public
 */
export type ObjectVersion<TPayload = Response> = { meta: VersionMeta; payload: TPayload };
/** App-encrypted bytes and metadata submitted against an expected remote head.
 * @public
 */
export type CommitInput = {
  meta: VersionMeta;
  /** App-encrypted payload; never submit private plaintext. */
  payload: Blob | Uint8Array;
  /** Last observed head, or null to create an object. */
  expectedHeadVersionId: string | null;
};
/** A successful commit or a CAS rejection; other failures throw ClientError.
 * @public
 */
export type CommitResult = { ok: true } | { ok: false; reason: "version-mismatch" | "conflict" };
/** Opaque pagination cursor, optional positive page limit and cancellation.
 * @public
 */
export type PageOptions = RequestOptions & { cursor?: string | null; limit?: number };
/** Committed-version metadata with ancestry and an opaque continuation cursor.
 * @public
 */
export type VersionHistory = VersionMeta & { history: string[]; nextCursor: string | null };
/** One page of changes. Continue from cursor while hasMore is true.
 * @public
 */
export type FeedPage = { entries: FeedHint[]; cursor: string; hasMore: boolean; [field: string]: unknown };
/** Current object heads and the starting cursor for feed catch-up.
 * @public
 */
export type BucketIndex = { bucketId: string; objects: FeedHint[]; feedCursor: string | null; hasMoreFeed: boolean; [field: string]: unknown };

/** The granted non-extractable AES-GCM key and remote bucket identity for app encryption.
 * @public
 */
export type BucketKey = { bucketId: string; keyId: string; cryptoKey: CryptoKey };

/** Storage-independent Remote operations. The application owns payload encryption, merge and recovery.
 * @public
 */
export interface RemoteBucket {
  /** Returns the granted key handle without a request. Use your own AAD and retain keyId. */
  getBucketKey(options?: RequestOptions): Promise<BucketKey>;
  /** Reads the current head, or null when absent. knownVersionId requests ancestry evidence. */
  getCurrent(objectId: string, options?: RequestOptions & { knownVersionId?: string | null }): Promise<CurrentVersion | null>;
  /** Reads metadata and a payload Response; consume or cancel its body. */
  getVersion(objectId: string, versionId: string, options?: RequestOptions): Promise<ObjectVersion>;
  /** Reads metadata for one committed version; missing versions throw. */
  getVersionMeta(objectId: string, versionId: string, options?: RequestOptions): Promise<VersionMeta>;
  /** Returns the encrypted payload Response; consume or cancel its body. */
  getPayload(objectId: string, versionId: string, options?: RequestOptions): Promise<Response>;
  /** Submits encrypted bytes with CAS. Preserve IDs and bytes after uncertain failures. */
  commit(input: CommitInput, options?: RequestOptions): Promise<CommitResult>;
  /** Reads committed-version history anchored at one object/version; follow nextCursor. */
  listVersions(objectId: string, versionId: string, options?: PageOptions): Promise<VersionHistory>;
  /** Reads the current heads snapshot and its feed catch-up cursor. */
  getIndex(options?: RequestOptions): Promise<BucketIndex>;
  /** Reads a feed page; continue from cursor while hasMore is true. */
  listFeed(options?: PageOptions): Promise<FeedPage>;
  /** Awaits subscription readiness and yields hints. Catch up after subscribing; no automatic reconnect. */
  watchFeed(options?: RequestOptions): Promise<AsyncGenerator<FeedHint>>;
}

export type RemoteBucketClient = Omit<RemoteBucket, "getBucketKey">;

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

export function createBucketClient(request: RemoteRequest, bucketId: string): RemoteBucketClient {
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
