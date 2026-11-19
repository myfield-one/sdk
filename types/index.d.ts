/** Binary input supported by Local field values.
 * @public
 */
export declare type BinaryInput = Blob | ArrayBuffer | Uint8Array;

/** Optional binary metadata stored inside encrypted Local payloads.
 * @public
 */
export declare type BinaryOptions = {
    mimeType?: string;
    name?: string;
    lastModified?: number;
};

/** Local-first object storage. Network synchronization requires a connection.
 * @public
 */
export declare type Bucket = {
    /** The local resource label; the granted remote bucket ID may differ. */
    readonly id: string;
    /** Current connection state. */
    readonly state: BucketState;
    /** Wraps a binary field without uploading it. */
    binary(input: BinaryInput | BucketBinaryValue, options?: BinaryOptions): BucketBinaryValue;
    /** @deprecated No-op kept for compatibility; operations initialize storage lazily. */
    ready(): Promise<void>;
    /** Replaces known local fields; concurrent unknown remote fields remain mergeable. */
    put(objectId: string, object: Record<string, unknown>): Promise<void>;
    /** Reads local data, returning null for absent or deleted objects. */
    get(objectId: string): Promise<Record<string, unknown> | null>;
    /** Updates top-level fields; undefined deletes a field. */
    update(objectId: string, fields: Record<string, unknown>): Promise<void>;
    /** Creates a local deletion and schedules synchronization when connected. */
    delete(objectId: string): Promise<void>;
    /** Lists known local objects newest first; does not query the cloud. */
    list(options?: {
        prefix?: string;
        includeDeleted?: boolean;
    }): Promise<ListEntry[]>;
    /** Restores saved authorization without prompting. Load local data first. */
    resume(): Promise<BucketState>;
    /** Connects from a user gesture; authorization failures report disconnected state. */
    connect(options?: ConnectOptions): Promise<BucketState>;
    /** Drops authorization and connection while retaining local objects and identity keys. */
    disconnect(): Promise<void>;
    /** Runs one Local sync pass; rejects when disconnected. */
    sync(): Promise<void>;
    /** Enables or disables automatic Local sync; an active pass may finish. */
    setAutoSync(enabled: boolean): void;
    /** Subscribes to state or local changes; returns an unsubscribe function. */
    on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
    /** Subscribes to state or local changes; returns an unsubscribe function. */
    on(event: "change", handler: (objectId: string) => void): () => void;
    /** Stops this bucket runtime and releases listeners and sync resources. */
    dispose(): void;
    /* Excluded from this release type: __bindTestTransport */
};

/** A binary field handle. Read bytes explicitly through its asynchronous methods.
 * @public
 */
export declare type BucketBinaryValue = {
    readonly kind: "binary";
    readonly size: number;
    readonly mimeType?: string;
    readonly name?: string;
    readonly lastModified?: number;
    blob(): Promise<Blob>;
    arrayBuffer(): Promise<ArrayBuffer>;
};

/** Current object heads and the starting cursor for feed catch-up.
 * @public
 */
export declare type BucketIndex = {
    bucketId: string;
    objects: FeedHint[];
    feedCursor: string | null;
    hasMoreFeed: boolean;
    [field: string]: unknown;
};

/** The granted non-extractable AES-GCM key and remote bucket identity for app encryption.
 * @public
 */
export declare type BucketKey = {
    bucketId: string;
    keyId: string;
    cryptoKey: CryptoKey;
};

/** Connection state shared with the associated resource.
 * @public
 */
export declare type BucketState = "disconnected" | "connecting" | "connected";

declare type BucketTransportLike = {
    pullHead(wireObjectId: string): Promise<TransportHeadResult>;
    pullPayload(wireObjectId: string, versionId: string): Promise<TransportPayloadResult>;
    push(wireObjectId: string, plaintext: Uint8Array, expectedHeadVersionId: string | null): Promise<TransportPushResult>;
    listHeads?(): Promise<Map<string, string>>;
};

/** Machine-readable SDK failure with optional HTTP and retry diagnostics.
 * @public
 */
export declare class ClientError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly requestId?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly maxBytes?: number;
    constructor(code: string, message: string, options?: ClientErrorOptions);
}

/** HTTP diagnostics, retry information, payload limit and original cause.
 * @public
 */
export declare type ClientErrorOptions = {
    status?: number;
    requestId?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    maxBytes?: number;
    cause?: unknown;
};

/** App-encrypted bytes and metadata submitted against an expected remote head.
 * @public
 */
export declare type CommitInput = {
    meta: VersionMeta;
    /** App-encrypted payload; never submit private plaintext. */
    payload: Blob | Uint8Array;
    /** Last observed head, or null to create an object. */
    expectedHeadVersionId: string | null;
};

/** A successful commit or a CAS rejection; other failures throw ClientError.
 * @public
 */
export declare type CommitResult = {
    ok: true;
} | {
    ok: false;
    reason: "version-mismatch" | "conflict";
};

/** Automatic Local synchronization settings; defaults to enabled.
 * @public
 */
export declare type ConnectOptions = {
    /** Enable automatic Local sync after connecting; defaults to true. */
    autoSync?: boolean;
};

/** Creates a local Instance with an explicit application ID. No network I/O.
 * @public
 */
export declare function createInstance(appId: string): Instance;

/** Creates a local Instance; appId defaults to the browser hostname.
 * @public
 */
export declare function createInstance(options?: CreateInstanceOptions): Instance;

/** Local persistence scope and authorization page settings. Creating an Instance does not connect.
 * @public
 */
export declare type CreateInstanceOptions = {
    /** Existing local storage scope; defaults to explicit appId, otherwise "default". */
    namespace?: string;
    /** IndexedDB by default; memory is useful for tests and ephemeral clients. */
    storage?: "indexeddb" | "memory";
    /** Stable lowercase domain-form application ID; defaults to the browser hostname. */
    appId?: string;
    /** Absolute HTTP(S) Auth page URL without credentials, query or fragment. */
    authUrl?: string;
};

/** The current committed version, with optional newest-first ancestry evidence.
 * @public
 */
export declare type CurrentVersion = {
    versionId: string;
    headVersionMeta: VersionMeta;
    history?: string[] | null;
    [field: string]: unknown;
};

/** An object/version notification that prompts feed catch-up, not an object payload.
 * @public
 */
export declare type FeedHint = {
    objectId: string;
    versionId: string;
};

/** One page of changes. Continue from cursor while hasMore is true.
 * @public
 */
export declare type FeedPage = {
    entries: FeedHint[];
    cursor: string;
    hasMore: boolean;
    [field: string]: unknown;
};

/** Application identity, authorization and access to Local and Remote buckets.
 * @public
 */
export declare type Instance = {
    /** Local persistence namespace; never sent as the remote bucket ID. */
    readonly namespace: string;
    /** Remote access for the default bucket; the app owns encryption and local storage. */
    readonly remote: {
        getBucket(): RemoteBucket;
    };
    /** Current connection state. */
    readonly state: BucketState;
    /** Returns the cached default Local bucket identified by appId. */
    getBucket(): Bucket;
    /** Reads the saved instance identity, or null when absent. */
    getKey(): Promise<InstanceKey | null>;
    /** Creates an identity when disconnected; rejects if a key already exists. */
    createKey(): Promise<InstanceKey>;
    /** Validates and saves an identity when disconnected; does not import grants. */
    importKey(key: InstanceKey): Promise<void>;
    /** Removes the identity and dependent authorization when disconnected. */
    removeKey(): Promise<void>;
    /** Restores saved authorization without prompting. Load local data first. */
    resume(options?: {
        autoSync?: boolean;
    }): Promise<BucketState>;
    /** Connects from a user gesture; authorization failures report disconnected state. */
    connect(options?: {
        autoSync?: boolean;
    }): Promise<BucketState>;
    /** Drops authorization and connection while retaining local objects and identity keys. */
    disconnect(): Promise<void>;
    /** Subscribes to connection state and error notifications; returns an unsubscribe function. */
    on(event: "state", handler: (state: BucketState, error?: ClientError) => void): () => void;
    /** Gets a Local handle for another stable resource label; creation is local-only. */
    createBucket(options: {
        id: string;
    }): Bucket;
};

/** Persisted instance identity with public JWKs and non-extractable private CryptoKeys.
 * @public
 */
export declare type InstanceKey = {
    instanceId: string;
    signingPublicJwk: JsonWebKey;
    signingPrivateKey: CryptoKey;
    wrappingPublicJwk: JsonWebKey;
    wrappingPrivateKey: CryptoKey;
    createdAt: string;
};

/** Known local object ID and UTC ISO update time; deleted entries are opt-in.
 * @public
 */
export declare type ListEntry = {
    id: string;
    updatedAt: string;
    deleted?: true;
};

/** A Local sync operation requires an active connection.
 * @public
 */
export declare class NotConnectedError extends Error {
    constructor();
}

/** Version metadata and its payload. Consume or cancel Response bodies.
 * @public
 */
export declare type ObjectVersion<TPayload = Response> = {
    meta: VersionMeta;
    payload: TPayload;
};

/** The Local sync transport is unavailable.
 * @public
 */
export declare class OfflineError extends Error {
    constructor();
}

/** Opaque pagination cursor, optional positive page limit and cancellation.
 * @public
 */
export declare type PageOptions = RequestOptions & {
    cursor?: string | null;
    limit?: number;
};

/** Storage-independent Remote operations. The application owns payload encryption, merge and recovery.
 * @public
 */
export declare interface RemoteBucket {
    /** Returns the granted key handle without a request. Use your own AAD and retain keyId. */
    getBucketKey(options?: RequestOptions): Promise<BucketKey>;
    /** Reads the current head, or null when absent. knownVersionId requests ancestry evidence. */
    getCurrent(objectId: string, options?: RequestOptions & {
        knownVersionId?: string | null;
    }): Promise<CurrentVersion | null>;
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

/** Cancellation for a Remote operation; requests are not automatically retried.
 * @public
 */
export declare type RequestOptions = {
    signal?: AbortSignal;
};

declare type TransportHeadResult = {
    found: false;
} | {
    found: true;
    versionId: string;
};

declare type TransportPayloadResult = {
    found: false;
} | {
    found: true;
    plaintext: Uint8Array;
};

declare type TransportPushResult = {
    ok: true;
    versionId: string;
} | {
    ok: false;
    conflict: true;
    remoteVersionId: string | null;
};

/** Committed-version metadata with ancestry and an opaque continuation cursor.
 * @public
 */
export declare type VersionHistory = VersionMeta & {
    history: string[];
    nextCursor: string | null;
};

/** Transport metadata. Application plaintext and private metadata must remain encrypted.
 * @public
 */
export declare type VersionMeta = {
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

export { }
