import { bytesToB64url } from "../internal/encoding.ts";

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

export type StoredBinaryValue = {
  __myfieldSdkType: "binary-v1";
  size: number;
  bytes: Uint8Array;
  mimeType?: string;
  name?: string;
  lastModified?: number;
};

const BINARY_HANDLE_MARKER = Symbol("myfield.sdk.binary");
const STORED_BINARY_TYPE = "binary-v1";

type RuntimeBinaryHandle = BucketBinaryValue & {
  readonly [BINARY_HANDLE_MARKER]: true;
};

export function createBucketBinaryValue(input: BinaryInput | BucketBinaryValue, options: BinaryOptions = {}): BucketBinaryValue {
  if (isBucketBinaryValue(input)) {
    return makeBinaryHandle(
      {
        size: input.size,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(typeof input.lastModified === "number" ? { lastModified: input.lastModified } : {}),
        ...normalizeBinaryOptions(options),
      },
      () => input.arrayBuffer()
    );
  }

  if (isBlobLike(input)) {
    const blob = input;
    const fileMeta = blob as Blob & { name?: unknown; lastModified?: unknown };
    return makeBinaryHandle(
      {
        size: blob.size,
        ...(blob.type ? { mimeType: blob.type } : {}),
        ...(typeof fileMeta.name === "string" && fileMeta.name ? { name: fileMeta.name } : {}),
        ...(typeof fileMeta.lastModified === "number" ? { lastModified: fileMeta.lastModified } : {}),
        ...normalizeBinaryOptions(options),
      },
      () => blob.arrayBuffer()
    );
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return makeBinaryHandle(
    {
      size: bytes.byteLength,
      ...normalizeBinaryOptions(options),
    },
    async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
}

export function isBucketBinaryValue(value: unknown): value is BucketBinaryValue {
  return !!value && typeof value === "object" && (value as Partial<RuntimeBinaryHandle>)[BINARY_HANDLE_MARKER] === true;
}

export function isStoredBinaryValue(value: unknown): value is StoredBinaryValue {
  const row = value as Partial<StoredBinaryValue> | null;
  return (
    !!row &&
    row.__myfieldSdkType === STORED_BINARY_TYPE &&
    typeof row.size === "number" &&
    Number.isSafeInteger(row.size) &&
    row.size >= 0 &&
    row.bytes instanceof Uint8Array &&
    row.bytes.byteLength === row.size &&
    optionalString(row.mimeType) &&
    optionalString(row.name) &&
    optionalNumber(row.lastModified)
  );
}

export async function toStoredBinaryValue(value: BucketBinaryValue | StoredBinaryValue): Promise<StoredBinaryValue> {
  if (isStoredBinaryValue(value)) return cloneStoredBinaryValue(value);
  if (!isBucketBinaryValue(value)) throw new Error("binary value must be created with bucket.binary()");
  const bytes = new Uint8Array(await value.arrayBuffer());
  if (bytes.byteLength !== value.size) throw new Error("binary value size changed while reading");
  return {
    __myfieldSdkType: STORED_BINARY_TYPE,
    size: bytes.byteLength,
    bytes,
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
    ...(value.name ? { name: value.name } : {}),
    ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
  };
}

export function hydrateBinaryValue(value: StoredBinaryValue): BucketBinaryValue {
  const stored = cloneStoredBinaryValue(value);
  return makeBinaryHandle(
    {
      size: stored.size,
      ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
      ...(stored.name ? { name: stored.name } : {}),
      ...(typeof stored.lastModified === "number" ? { lastModified: stored.lastModified } : {}),
    },
    async () => stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength) as ArrayBuffer
  );
}

export function binaryValueToCanonicalJson(value: StoredBinaryValue): Record<string, unknown> {
  return {
    __myfieldSdkType: STORED_BINARY_TYPE,
    size: value.size,
    data: bytesToB64url(value.bytes),
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
    ...(value.name ? { name: value.name } : {}),
    ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
  };
}

export function fieldValueToCanonicalJson(value: unknown): unknown {
  if (isStoredBinaryValue(value)) return binaryValueToCanonicalJson(value);
  if (Array.isArray(value)) return value.map(fieldValueToCanonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, fieldValueToCanonicalJson(item)])
    );
  }
  return value;
}

export async function canonicalizeFieldValue(value: unknown, seen = new WeakSet<object>()): Promise<unknown> {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number field values must be finite");
    return value;
  }
  if (isBucketBinaryValue(value) || isStoredBinaryValue(value)) return toStoredBinaryValue(value);
  if (isRawBinaryInput(value)) throw new Error("binary field values must be created with bucket.binary()");
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cyclic field values are not supported");
    seen.add(value);
    const out = [];
    for (const item of value) out.push(await canonicalizeFieldValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (!isPlainObject(value)) throw new Error("field values must be JSON-compatible or created with bucket.binary()");
    if (seen.has(value)) throw new Error("cyclic field values are not supported");
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await canonicalizeFieldValue(item, seen);
    seen.delete(value);
    return out;
  }
  throw new Error("field values must be JSON-compatible or created with bucket.binary()");
}

export async function canonicalizeFieldMap(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) out[name] = await canonicalizeFieldValue(value);
  return out;
}

export function hydrateFieldValue(value: unknown): unknown {
  if (isStoredBinaryValue(value)) return hydrateBinaryValue(value);
  if (Array.isArray(value)) return value.map(hydrateFieldValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hydrateFieldValue(item)]));
  }
  return value;
}

export function cloneStoredBinaryValue(value: StoredBinaryValue): StoredBinaryValue {
  return {
    __myfieldSdkType: STORED_BINARY_TYPE,
    size: value.size,
    bytes: new Uint8Array(value.bytes),
    ...(value.mimeType ? { mimeType: value.mimeType } : {}),
    ...(value.name ? { name: value.name } : {}),
    ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
  };
}

function makeBinaryHandle(
  meta: { size: number; mimeType?: string; name?: string; lastModified?: number },
  load: () => Promise<ArrayBuffer>
): BucketBinaryValue {
  const handle: BucketBinaryValue = {
    kind: "binary",
    size: meta.size,
    ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
    ...(meta.name ? { name: meta.name } : {}),
    ...(typeof meta.lastModified === "number" ? { lastModified: meta.lastModified } : {}),
    async blob() {
      return new Blob([await load()], { type: meta.mimeType || "" });
    },
    async arrayBuffer() {
      const buffer = await load();
      return buffer.slice(0);
    },
  };
  Object.defineProperty(handle, BINARY_HANDLE_MARKER, { value: true });
  return handle;
}

function normalizeBinaryOptions(options: BinaryOptions): BinaryOptions {
  return {
    ...(typeof options.mimeType === "string" && options.mimeType ? { mimeType: options.mimeType } : {}),
    ...(typeof options.name === "string" && options.name ? { name: options.name } : {}),
    ...(typeof options.lastModified === "number" && Number.isFinite(options.lastModified) ? { lastModified: options.lastModified } : {}),
  };
}

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isRawBinaryInput(value: unknown): value is BinaryInput {
  return isBlobLike(value) || value instanceof ArrayBuffer || value instanceof Uint8Array;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}
