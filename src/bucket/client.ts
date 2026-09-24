// Local-first bucket client. Reads and writes hit the local store first;
// sync reconciles with the relay through the CAS retry loop
// (push conflict → pull current → merge → re-push), which converges because
// every merge strategy is required to be state-based convergent.
//
// The relay may have evicted any object. A remote miss with a surviving
// local record is healed by re-pushing the local state (CAS create).

import {
  applyLwwMapUpdates,
  decodePayloadDoc,
  emptyLwwMapDoc,
  encodePayloadDoc,
  lwwMapDocsEqual,
  lwwMapLatestTs,
  lwwMapValues,
  LwwClock,
  mergeLwwMapDocs,
  type LwwMapDoc,
  type OpaqueDoc,
  type PayloadDoc,
} from "./format.ts";
import { canonicalizeFieldMap } from "./binary.ts";
import type { StorageAdapter } from "./store.ts";
import { BucketTransportError, type TransportHeadResult, type TransportPayloadResult, type TransportPushResult } from "./transport.ts";

export type MergeStrategy = { kind: "lww-map" } | { kind: "opaque"; merge: (local: unknown, remote: unknown) => unknown };

export type BucketTransportLike = {
  pullHead(wireObjectId: string): Promise<TransportHeadResult>;
  pullPayload(wireObjectId: string, versionId: string): Promise<TransportPayloadResult>;
  push(wireObjectId: string, plaintext: Uint8Array, expectedHeadVersionId: string | null): Promise<TransportPushResult>;
  listHeads?(): Promise<Map<string, string>>;
};

export type ChangeSource = "local" | "remote";

export type SyncPassOptions = {
  skipWireIds?: Iterable<string>;
  resolveUnknown?: (wireObjectId: string, versionId: string) => Promise<string | null>;
};

export type BucketClientOptions = {
  transport: BucketTransportLike;
  storage: StorageAdapter;
  actorId: string;
  wireObjectId?: (appObjectId: string) => Promise<string>;
  storagePrefix?: string;
  mergeStrategyFor?: (appObjectId: string) => MergeStrategy;
  maxCasAttempts?: number;
  pushDebounceMs?: number;
  localOnlyObjectIds?: Iterable<string>;
  validateRemote?: (appObjectId: string, doc: PayloadDoc) => void;
  onChange?: (appObjectId: string, source: ChangeSource) => void;
  onSyncError?: (appObjectId: string | null, error: unknown) => void;
};

type LocalObjectRecord = {
  v: 1;
  doc: PayloadDoc;
  remoteVersionId: string | null;
  dirty: boolean;
};

const DEFAULT_MAX_CAS_ATTEMPTS = 5;
const DEFAULT_PUSH_DEBOUNCE_MS = 800;
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENCODED_OBJECT_BYTES = 100 * 1024 * 1024;

export class BucketClient {
  private readonly transport: BucketTransportLike;
  private readonly storage: StorageAdapter;
  private readonly actorId: string;
  private readonly wireId: (appObjectId: string) => Promise<string>;
  private readonly prefix: string;
  private readonly mergeStrategyFor: (appObjectId: string) => MergeStrategy;
  private readonly maxCasAttempts: number;
  private readonly pushDebounceMs: number;
  private readonly maxEncodedObjectBytes = DEFAULT_MAX_ENCODED_OBJECT_BYTES;
  private readonly localOnly: Set<string>;
  private readonly validateRemote?: (appObjectId: string, doc: PayloadDoc) => void;
  private readonly onChange?: (appObjectId: string, source: ChangeSource) => void;
  private readonly onSyncError?: (appObjectId: string | null, error: unknown) => void;
  private readonly clock = new LwwClock();
  private readonly inFlightSync = new Map<string, Promise<boolean>>();
  private readonly objectLocks = new Map<string, Promise<void>>();
  private readonly pendingPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watched = new Set<string>();
  // Avoids re-downloading an unresolvable object until its head changes.
  private readonly unresolved = new Map<string, string>();
  private triggerCleanup: (() => void) | null = null;
  private disposed = false;

  constructor(options: BucketClientOptions) {
    this.transport = options.transport;
    this.storage = options.storage;
    this.actorId = options.actorId;
    this.wireId = options.wireObjectId || (async (id) => id);
    this.prefix = options.storagePrefix || "myfield-sdk";
    this.mergeStrategyFor = options.mergeStrategyFor || (() => ({ kind: "lww-map" }));
    this.maxCasAttempts = options.maxCasAttempts ?? DEFAULT_MAX_CAS_ATTEMPTS;
    this.pushDebounceMs = options.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    this.localOnly = new Set(options.localOnlyObjectIds || []);
    this.validateRemote = options.validateRemote;
    this.onChange = options.onChange;
    this.onSyncError = options.onSyncError;
  }

  // ---- local reads -------------------------------------------------------

  async getFields(appObjectId: string): Promise<Record<string, unknown> | null> {
    const record = await this.readRecord(appObjectId);
    if (!record || record.doc.t !== "lww-map") return null;
    return lwwMapValues(record.doc);
  }

  async getData(appObjectId: string): Promise<unknown> {
    const record = await this.readRecord(appObjectId);
    if (!record || record.doc.t !== "opaque") return null;
    return record.doc.data;
  }

  async lastModified(appObjectId: string): Promise<number | null> {
    const record = await this.readRecord(appObjectId);
    return record && record.doc.t === "lww-map" ? lwwMapLatestTs(record.doc) : null;
  }

  async knownObjectIds(): Promise<string[]> {
    const keys = await this.storage.keys(`${this.prefix}:obj:`);
    return keys.map((key) => decodeURIComponent(key.slice(`${this.prefix}:obj:`.length)));
  }

  // ---- local writes ------------------------------------------------------

  // Every read-modify-write of a local record runs through a per-object
  // queue: interleaved async writers (concurrent setFields, or a sync merge
  // racing a local write) would otherwise clobber each other's snapshot and
  // silently lose fields.
  private withObjectLock<T>(appObjectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.objectLocks.get(appObjectId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.objectLocks.set(
      appObjectId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  // `undefined` field values delete the field (tombstone).
  setFields(appObjectId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.withObjectLock(appObjectId, async () => {
      const record = await this.readRecord(appObjectId);
      const baseDoc: LwwMapDoc = record && record.doc.t === "lww-map" ? record.doc : emptyLwwMapDoc();
      this.clock.observeDoc(baseDoc);
      const nextDoc = applyLwwMapUpdates(baseDoc, await canonicalizeFieldMap(updates), this.clock, this.actorId);
      this.assertEncodedObjectSize(nextDoc);
      await this.writeRecord(appObjectId, {
        v: 1,
        doc: nextDoc,
        remoteVersionId: record?.remoteVersionId ?? null,
        dirty: true,
      });
      this.schedulePush(appObjectId);
      this.onChange?.(appObjectId, "local");
      return lwwMapValues(nextDoc);
    });
  }

  setData(appObjectId: string, data: unknown): Promise<void> {
    return this.withObjectLock(appObjectId, async () => {
      const record = await this.readRecord(appObjectId);
      const nextDoc: OpaqueDoc = { t: "opaque", data };
      this.assertEncodedObjectSize(nextDoc);
      await this.writeRecord(appObjectId, {
        v: 1,
        doc: nextDoc,
        remoteVersionId: record?.remoteVersionId ?? null,
        dirty: true,
      });
      this.schedulePush(appObjectId);
      this.onChange?.(appObjectId, "local");
    });
  }

  // ---- sync --------------------------------------------------------------

  // Reconciles one object with the relay. Returns true when the local view
  // changed because of remote data.
  syncObject(appObjectId: string): Promise<boolean> {
    const inFlight = this.inFlightSync.get(appObjectId);
    if (inFlight) return inFlight;
    const promise = this.performSync(appObjectId).finally(() => {
      if (this.inFlightSync.get(appObjectId) === promise) this.inFlightSync.delete(appObjectId);
    });
    this.inFlightSync.set(appObjectId, promise);
    return promise;
  }

  async syncObjects(appObjectIds: Iterable<string>): Promise<void> {
    await Promise.all(Array.from(appObjectIds, (id) => this.syncObject(id).catch((error) => this.onSyncError?.(id, error))));
  }

  async syncKnown(): Promise<void> {
    const ids = new Set([...(await this.knownObjectIds()), ...this.watched]);
    await this.syncObjects(ids);
  }

  async syncPass(options: SyncPassOptions = {}): Promise<void> {
    if (!this.transport.listHeads) throw new Error("transport does not list current heads");
    const heads = await this.transport.listHeads();
    for (const wireObjectId of options.skipWireIds || []) heads.delete(wireObjectId);
    const known = new Map<string, string>();
    const ids = new Set([...this.watched].filter((id) => !this.localOnly.has(id)));
    for (const id of await this.knownObjectIds()) {
      if (this.localOnly.has(id)) continue;
      const record = await this.readRecord(id);
      if (!record) continue;
      const wireObjectId = await this.wireId(id);
      known.set(wireObjectId, id);
      const head = heads.get(wireObjectId);
      if (record.dirty || head === undefined || head !== record.remoteVersionId) ids.add(id);
    }
    for (const [wireObjectId, versionId] of heads) {
      if (known.has(wireObjectId) || !options.resolveUnknown || this.unresolved.get(wireObjectId) === versionId) continue;
      try {
        const id = await options.resolveUnknown(wireObjectId, versionId);
        if (id && !this.localOnly.has(id) && (await this.wireId(id)) === wireObjectId) {
          this.unresolved.delete(wireObjectId);
          ids.add(id);
        } else {
          this.unresolved.set(wireObjectId, versionId);
        }
      } catch (error) {
        this.onSyncError?.(null, error);
      }
    }
    await this.syncObjects(ids);
  }

  async pullDoc(wireObjectId: string, versionId: string): Promise<PayloadDoc | null> {
    const payload = await this.transport.pullPayload(wireObjectId, versionId);
    return payload.found ? decodePayloadDoc(payload.plaintext) : null;
  }

  async pullRemoteDoc(appObjectId: string): Promise<PayloadDoc | null> {
    const wireObjectId = await this.wireId(appObjectId);
    const head = await this.transport.pullHead(wireObjectId);
    return head.found ? this.pullDoc(wireObjectId, head.versionId) : null;
  }

  watch(appObjectIds: Iterable<string>): void {
    for (const id of appObjectIds) this.watched.add(id);
  }

  // Sync-trigger model: launch (start itself) and a timer fallback.
  // Browser/app lifecycle triggers are owned by the app; post-write pushes
  // are scheduled by setFields/setData.
  start(options: { intervalMs?: number; run: () => Promise<void> }): void {
    if (this.triggerCleanup || this.disposed) return;
    const run = options.run;
    const kick = () => void run().catch((error) => this.onSyncError?.(null, error));
    const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    const timer = intervalMs > 0 ? setInterval(kick, intervalMs) : null;
    this.triggerCleanup = () => {
      if (timer) clearInterval(timer);
    };
    kick();
  }

  stop(): void {
    this.triggerCleanup?.();
    this.triggerCleanup = null;
    for (const timer of this.pendingPushTimers.values()) clearTimeout(timer);
    this.pendingPushTimers.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async flush(appObjectId?: string): Promise<void> {
    const ids = appObjectId ? [appObjectId] : Array.from(this.pendingPushTimers.keys());
    for (const id of ids) {
      const timer = this.pendingPushTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.pendingPushTimers.delete(id);
      }
    }
    await this.syncObjects(ids);
  }

  // ---- internals ---------------------------------------------------------

  private schedulePush(appObjectId: string): void {
    if (this.disposed || this.localOnly.has(appObjectId)) return;
    const existing = this.pendingPushTimers.get(appObjectId);
    if (existing) clearTimeout(existing);
    this.pendingPushTimers.set(
      appObjectId,
      setTimeout(() => {
        this.pendingPushTimers.delete(appObjectId);
        void this.syncObject(appObjectId).catch((error) => this.onSyncError?.(appObjectId, error));
      }, this.pushDebounceMs)
    );
  }

  private async performSync(appObjectId: string): Promise<boolean> {
    if (this.localOnly.has(appObjectId)) return false;
    const wireObjectId = await this.wireId(appObjectId);
    let remoteChangedLocal = false;
    for (let attempt = 0; attempt < this.maxCasAttempts; attempt += 1) {
      // Each attempt holds the object lock across read → merge → write so a
      // concurrent local setFields cannot land between the snapshot and the
      // record write and get clobbered. Between attempts the lock is
      // released, so local writes slip in and the next attempt re-reads them.
      const outcome = await this.withObjectLock(appObjectId, async (): Promise<"retry" | boolean> => {
        const record = await this.readRecord(appObjectId);
        const head = await this.transport.pullHead(wireObjectId);

        if (!head.found) {
          if (!record) return false;
          // Relay miss with surviving local state: re-create (self-healing).
          const result = await this.transport.push(wireObjectId, encodePayloadDoc(record.doc), null);
          if (result.ok) {
            await this.writeRecord(appObjectId, { ...record, remoteVersionId: result.versionId, dirty: false });
            return remoteChangedLocal;
          }
          return "retry";
        }

        if (record && !record.dirty && record.remoteVersionId === head.versionId) return remoteChangedLocal;

        const payload = await this.transport.pullPayload(wireObjectId, head.versionId);
        if (!payload.found) return "retry";
        const remoteDoc = decodePayloadDoc(payload.plaintext);
        this.validateRemote?.(appObjectId, remoteDoc);
        const merged = record ? this.merge(appObjectId, record.doc, remoteDoc) : remoteDoc;
        const localViewChanged = !record || !docsEqual(merged, record.doc);
        const remoteNeedsUpdate = !docsEqual(merged, remoteDoc);

        if (merged.t === "lww-map") this.clock.observeDoc(merged);

        if (!remoteNeedsUpdate) {
          await this.writeRecord(appObjectId, { v: 1, doc: merged, remoteVersionId: head.versionId, dirty: false });
          if (localViewChanged) {
            remoteChangedLocal = true;
            this.onChange?.(appObjectId, "remote");
          }
          return remoteChangedLocal;
        }

        const result = await this.transport.push(wireObjectId, encodePayloadDoc(merged), head.versionId);
        if (result.ok) {
          await this.writeRecord(appObjectId, { v: 1, doc: merged, remoteVersionId: result.versionId, dirty: false });
          if (localViewChanged) {
            remoteChangedLocal = true;
            this.onChange?.(appObjectId, "remote");
          }
          return remoteChangedLocal;
        }
        // CAS conflict: retry pulls the newer head and merges again.
        return "retry";
      });
      if (outcome !== "retry") return outcome;
    }
    throw new BucketTransportError("sync did not converge within CAS attempt limit", 409);
  }

  private merge(appObjectId: string, local: PayloadDoc, remote: PayloadDoc): PayloadDoc {
    const strategy = this.mergeStrategyFor(appObjectId);
    if (strategy.kind === "lww-map") {
      if (local.t !== "lww-map" || remote.t !== "lww-map") throw new Error(`object ${appObjectId} is not an lww-map payload`);
      return mergeLwwMapDocs(local, remote);
    }
    if (local.t !== "opaque" || remote.t !== "opaque") throw new Error(`object ${appObjectId} is not an opaque payload`);
    return { t: "opaque", data: strategy.merge(local.data, remote.data) };
  }

  private recordKey(appObjectId: string): string {
    return `${this.prefix}:obj:${encodeURIComponent(appObjectId)}`;
  }

  async dirtyObjectIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const id of await this.knownObjectIds()) {
      if (this.localOnly.has(id)) continue;
      const record = await this.readRecord(id);
      if (record?.dirty) ids.push(id);
    }
    return ids;
  }

  private async readRecord(appObjectId: string): Promise<LocalObjectRecord | null> {
    const record = await this.storage.get<LocalObjectRecord>(this.recordKey(appObjectId));
    if (!record || record.v !== 1 || !record.doc) return null;
    return record;
  }

  private writeRecord(appObjectId: string, record: LocalObjectRecord): Promise<void> {
    return this.storage.set(this.recordKey(appObjectId), record);
  }

  private assertEncodedObjectSize(doc: PayloadDoc): void {
    const size = encodePayloadDoc(doc).byteLength;
    if (size > this.maxEncodedObjectBytes) {
      throw new Error(`encoded object payload exceeds ${this.maxEncodedObjectBytes} bytes`);
    }
  }
}

function docsEqual(a: PayloadDoc, b: PayloadDoc): boolean {
  if (a.t === "lww-map" && b.t === "lww-map") return lwwMapDocsEqual(a, b);
  if (a.t === "opaque" && b.t === "opaque") return JSON.stringify(a.data) === JSON.stringify(b.data);
  return false;
}

