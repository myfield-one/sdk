// LWW-Map payload format. Everything in this file describes plaintext that
// only exists inside the encrypted payload; the worker never sees it.
//
// Wire layout:
//   [1-byte format version][4-byte big-endian header length][utf8 JSON header][binary parts...]
// Document body:
//   { t: "lww-map", fields: { name: { v, ts, actor } }, tombstones: { name: { ts, actor } } }
//   or { t: "opaque", data: <arbitrary JSON> } for custom merge strategies.
// Binary typed field values are represented in the JSON header as part references
// and carried as raw bytes in the binary parts section.

import { utf8Decode, utf8Encode } from "../internal/encoding.ts";
import {
  cloneStoredBinaryValue,
  fieldValueToCanonicalJson,
  hydrateFieldValue,
  isStoredBinaryValue,
  type StoredBinaryValue,
} from "./binary.ts";

export const PAYLOAD_FORMAT_VERSION = 1;
const HEADER_LENGTH_BYTES = 4;
const PART_LENGTH_BYTES = 4;
const BINARY_PART_MARKER = "binary-part-v1";

export type LwwFieldEntry = { v: unknown; ts: number; actor: string };
export type LwwTombstone = { ts: number; actor: string };

export type LwwMapDoc = {
  t: "lww-map";
  fields: Record<string, LwwFieldEntry>;
  tombstones: Record<string, LwwTombstone>;
};

export type OpaqueDoc = { t: "opaque"; data: unknown };

export type PayloadDoc = LwwMapDoc | OpaqueDoc;

export function emptyLwwMapDoc(): LwwMapDoc {
  return { t: "lww-map", fields: {}, tombstones: {} };
}

export function encodePayloadDoc(doc: PayloadDoc): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = utf8Encode(JSON.stringify(encodeHeaderValue(doc, parts)));
  let totalLength = 1 + HEADER_LENGTH_BYTES + header.byteLength;
  for (const part of parts) totalLength += PART_LENGTH_BYTES + part.byteLength;
  const out = new Uint8Array(totalLength);
  out[0] = PAYLOAD_FORMAT_VERSION;
  writeU32(out, 1, header.byteLength);
  out.set(header, 1 + HEADER_LENGTH_BYTES);
  let offset = 1 + HEADER_LENGTH_BYTES + header.byteLength;
  for (const part of parts) {
    writeU32(out, offset, part.byteLength);
    offset += PART_LENGTH_BYTES;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function decodePayloadDoc(bytes: Uint8Array): PayloadDoc {
  if (bytes.length < 2) throw new Error("payload too short");
  const version = bytes[0];
  if (version !== PAYLOAD_FORMAT_VERSION) throw new Error(`unsupported payload format version: ${version}`);
  if (bytes.length < 1 + HEADER_LENGTH_BYTES) throw new Error("payload header too short");
  const headerLength = readU32(bytes, 1);
  const headerStart = 1 + HEADER_LENGTH_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.length) throw new Error("payload header length out of range");
  const parsed = JSON.parse(utf8Decode(bytes.subarray(headerStart, headerEnd)));
  const parts: Uint8Array[] = [];
  let offset = headerEnd;
  while (offset < bytes.length) {
    if (offset + PART_LENGTH_BYTES > bytes.length) throw new Error("payload part length out of range");
    const partLength = readU32(bytes, offset);
    offset += PART_LENGTH_BYTES;
    if (offset + partLength > bytes.length) throw new Error("payload part out of range");
    parts.push(bytes.slice(offset, offset + partLength));
    offset += partLength;
  }
  return parsePayloadDoc(decodeHeaderValue(parsed, parts));
}

function parsePayloadDoc(parsed: unknown): PayloadDoc {
  const docRoot = parsed as Partial<PayloadDoc> | null;
  if (docRoot?.t === "lww-map") {
    const doc = docRoot as Partial<LwwMapDoc>;
    if (!isRecord(doc.fields) || !isRecord(doc.tombstones)) throw new Error("invalid lww-map payload");
    for (const entry of Object.values(doc.fields)) {
      if (!isLwwFieldEntry(entry)) throw new Error("invalid lww-map field entry");
    }
    for (const entry of Object.values(doc.tombstones)) {
      if (!isLwwTombstone(entry)) throw new Error("invalid lww-map tombstone");
    }
    return { t: "lww-map", fields: doc.fields as Record<string, LwwFieldEntry>, tombstones: doc.tombstones as Record<string, LwwTombstone> };
  }
  if (docRoot?.t === "opaque") return { t: "opaque", data: (docRoot as OpaqueDoc).data };
  throw new Error("unknown payload doc type");
}

// (ts, actor) total order: higher timestamp wins; equal timestamps fall back
// to actor id lexicographic order so every replica picks the same winner.
function wins(aTs: number, aActor: string, bTs: number, bActor: string): boolean {
  if (aTs !== bTs) return aTs > bTs;
  return aActor > bActor;
}

// A well-behaved actor never issues two different values under the same
// (ts, actor), but merge must stay deterministic even for malformed input:
// on a full (ts, actor) tie the serialized value breaks the tie.
function fieldEntryWins(a: LwwFieldEntry, b: LwwFieldEntry): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.actor !== b.actor) return a.actor > b.actor;
  return JSON.stringify(fieldValueToCanonicalJson(a.v)) > JSON.stringify(fieldValueToCanonicalJson(b.v));
}

// State-based LWW-Map merge: commutative, associative, idempotent. A field
// survives only if its entry beats every tombstone recorded for the same
// name; on an exact (ts, actor) tie between a value and a tombstone the
// tombstone wins so deletes are stable under replay.
export function mergeLwwMapDocs(a: LwwMapDoc, b: LwwMapDoc): LwwMapDoc {
  const tombstones: Record<string, LwwTombstone> = {};
  for (const source of [a.tombstones, b.tombstones]) {
    for (const [name, stone] of Object.entries(source)) {
      const existing = tombstones[name];
      if (!existing || wins(stone.ts, stone.actor, existing.ts, existing.actor)) tombstones[name] = { ts: stone.ts, actor: stone.actor };
    }
  }
  const fields: Record<string, LwwFieldEntry> = {};
  for (const source of [a.fields, b.fields]) {
    for (const [name, entry] of Object.entries(source)) {
      const existing = fields[name];
      if (!existing || fieldEntryWins(entry, existing)) fields[name] = { v: entry.v, ts: entry.ts, actor: entry.actor };
    }
  }
  for (const [name, stone] of Object.entries(tombstones)) {
    const entry = fields[name];
    if (entry && !wins(entry.ts, entry.actor, stone.ts, stone.actor)) delete fields[name];
  }
  return { t: "lww-map", fields, tombstones };
}

export function lwwMapDocsEqual(a: LwwMapDoc, b: LwwMapDoc): boolean {
  return JSON.stringify(canonicalLwwMapDoc(a)) === JSON.stringify(canonicalLwwMapDoc(b));
}

function canonicalLwwMapDoc(doc: LwwMapDoc): unknown {
  return {
    fields: Object.fromEntries(
      Object.entries(doc.fields)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, entry]) => [name, { ...entry, v: fieldValueToCanonicalJson(entry.v) }])
    ),
    tombstones: Object.fromEntries(Object.entries(doc.tombstones).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

// Plain field view with tombstones and metadata hidden.
export function lwwMapValues(doc: LwwMapDoc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc.fields).map(([name, entry]) => [name, hydrateFieldValue(entry.v)]));
}

// Hybrid clock: strictly monotonic per client and never behind any observed
// remote timestamp, so a device with a slow clock cannot silently lose wins.
export class LwwClock {
  private maxSeen = 0;

  observeDoc(doc: LwwMapDoc): void {
    for (const entry of Object.values(doc.fields)) this.observe(entry.ts);
    for (const stone of Object.values(doc.tombstones)) this.observe(stone.ts);
  }

  observe(ts: number): void {
    if (!Number.isFinite(ts)) return;
    if (ts > this.maxSeen) this.maxSeen = ts;
  }

  next(): number {
    const ts = Math.max(Date.now() + 1, this.maxSeen + 1);
    this.maxSeen = ts;
    return ts;
  }
}

// Applies local writes. `undefined` values delete the field (tombstone).
export function applyLwwMapUpdates(doc: LwwMapDoc, updates: Record<string, unknown>, clock: LwwClock, actor: string): LwwMapDoc {
  const next: LwwMapDoc = {
    t: "lww-map",
    fields: { ...doc.fields },
    tombstones: { ...doc.tombstones },
  };
  for (const [name, value] of Object.entries(updates)) {
    const ts = clock.next();
    if (value === undefined) {
      delete next.fields[name];
      next.tombstones[name] = { ts, actor };
    } else {
      next.fields[name] = { v: value, ts, actor };
      delete next.tombstones[name];
    }
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function encodeHeaderValue(value: unknown, parts: Uint8Array[]): unknown {
  if (isStoredBinaryValue(value)) {
    const index = parts.length;
    parts.push(value.bytes);
    return {
      __myfieldSdkType: BINARY_PART_MARKER,
      part: index,
      size: value.size,
      ...(value.mimeType ? { mimeType: value.mimeType } : {}),
      ...(value.name ? { name: value.name } : {}),
      ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((item) => encodeHeaderValue(item, parts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, encodeHeaderValue(item, parts)]));
  }
  return value;
}

function decodeHeaderValue(value: unknown, parts: Uint8Array[]): unknown {
  const maybePart = value as { __myfieldSdkType?: unknown; part?: unknown; size?: unknown; mimeType?: unknown; name?: unknown; lastModified?: unknown } | null;
  if (maybePart?.__myfieldSdkType === BINARY_PART_MARKER) {
    const partIndex = maybePart.part;
    if (typeof partIndex !== "number" || !Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) throw new Error("invalid binary part reference");
    const bytes = parts[partIndex];
    if (!bytes) throw new Error("missing binary part");
    if (typeof maybePart.size !== "number" || maybePart.size !== bytes.byteLength) throw new Error("binary part size mismatch");
    const stored: StoredBinaryValue = {
      __myfieldSdkType: "binary-v1",
      size: bytes.byteLength,
      bytes,
      ...(typeof maybePart.mimeType === "string" && maybePart.mimeType ? { mimeType: maybePart.mimeType } : {}),
      ...(typeof maybePart.name === "string" && maybePart.name ? { name: maybePart.name } : {}),
      ...(typeof maybePart.lastModified === "number" && Number.isFinite(maybePart.lastModified) ? { lastModified: maybePart.lastModified } : {}),
    };
    return cloneStoredBinaryValue(stored);
  }
  if (Array.isArray(value)) return value.map((item) => decodeHeaderValue(item, parts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, decodeHeaderValue(item, parts)]));
  }
  return value;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("uint32 out of range");
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function isLwwFieldEntry(value: unknown): value is LwwFieldEntry {
  const row = value as Partial<LwwFieldEntry> | null;
  return !!row && typeof row.ts === "number" && Number.isFinite(row.ts) && typeof row.actor === "string" && "v" in row;
}

function isLwwTombstone(value: unknown): value is LwwTombstone {
  const row = value as Partial<LwwTombstone> | null;
  return !!row && typeof row.ts === "number" && Number.isFinite(row.ts) && typeof row.actor === "string";
}
