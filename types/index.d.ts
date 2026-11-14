export type BinaryInput = Blob | ArrayBuffer | Uint8Array;

export type BinaryOptions = {
  mimeType?: string;
  name?: string;
  lastModified?: number;
};

export type BucketBinaryValue = {
  readonly kind: "binary";
  readonly size: number;
  readonly mimeType?: string;
  readonly name?: string;
  readonly lastModified?: number;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type CreateInstanceOptions = {
  namespace?: string;
  appId?: string;
  storage?: "indexeddb" | "memory";
  authUrl?: string;
};

export type BucketState = "disconnected" | "connecting" | "connected";

export type ListEntry = {
  id: string;
  updatedAt: string;
  deleted?: true;
};

export type ConnectOptions = {
  authBase?: string;
  autoSync?: boolean;
};

export type Bucket = {
  readonly id: string;
  readonly state: BucketState;
  binary(input: BinaryInput | BucketBinaryValue, options?: BinaryOptions): BucketBinaryValue;
  /** @deprecated No-op kept for compatibility; operations initialize storage lazily. */
  ready(): Promise<void>;
  put(objectId: string, object: Record<string, unknown>): Promise<void>;
  get(objectId: string): Promise<Record<string, unknown> | null>;
  update(objectId: string, fields: Record<string, unknown>): Promise<void>;
  delete(objectId: string): Promise<void>;
  list(options?: { prefix?: string; includeDeleted?: boolean }): Promise<ListEntry[]>;
  resume(): Promise<BucketState>;
  connect(options?: ConnectOptions): Promise<BucketState>;
  disconnect(): Promise<void>;
  sync(): Promise<void>;
  setAutoSync(enabled: boolean): void;
  on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
  on(event: "change", handler: (objectId: string) => void): () => void;
  dispose(): void;
};

export type Instance = {
  readonly namespace: string;
  readonly remote: { getBucket(): RemoteBucket };
  readonly state: BucketState;
  getBucket(): Bucket;
  getKey(): Promise<InstanceKey | null>;
  createKey(): Promise<InstanceKey>;
  importKey(key: InstanceKey): Promise<void>;
  removeKey(): Promise<void>;
  resume(options?: { autoSync?: boolean }): Promise<BucketState>;
  connect(options?: { autoSync?: boolean }): Promise<BucketState>;
  disconnect(): Promise<void>;
  on(event: "state", handler: (state: BucketState, error?: ClientError) => void): () => void;
  createBucket(options: { id: string }): Bucket;
};

export declare function createInstance(appId: string): Instance;
export declare function createInstance(options?: CreateInstanceOptions): Instance;

export declare class NotConnectedError extends Error {
  constructor();
}

export declare class OfflineError extends Error {
  constructor();
}

export type RequestOptions = { signal?: AbortSignal };

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
export type FeedHint = { objectId: string; versionId: string };
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

export type ClientErrorOptions = {
  status?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  maxBytes?: number;
  cause?: unknown;
};

export declare class ClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly maxBytes?: number;
  constructor(code: string, message: string, options?: ClientErrorOptions);
}

export type InstanceKey = {
  instanceId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  wrappingPublicJwk: JsonWebKey;
  wrappingPrivateKey: CryptoKey;
  createdAt: string;
};
