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
  storage?: "indexeddb" | "memory";
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
  createBucket(options: { id: string }): Bucket;
};

export declare function createInstance(options?: CreateInstanceOptions): Instance;

export declare class NotConnectedError extends Error {
  constructor();
}

export declare class OfflineError extends Error {
  constructor();
}
