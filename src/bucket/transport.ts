// HTTP transport for the open bucket surface: GET current, GET version
// payload, object CAS write, and current-head listing. Session credentials
// come from the auth layer; a 401 triggers one forced session refresh and
// retry before the error escalates (the auth layer decides whether that
// means disconnected).

import { fnv1a32Bytes, utf8Encode } from "../internal/encoding.ts";
import { decryptEnvelope, encryptEnvelopeFields } from "./crypto.ts";
import type { BucketKeys } from "./keys.ts";
import { REVOKED_AUTHORIZATION_CODES } from "../errors.ts";

export type SessionCredential = { carrier: "bearer"; token: string } | { carrier: "cookie" };

export type SessionProvider = {
  getSession(options?: { forceRefresh?: boolean }): Promise<SessionCredential>;
  onUnauthorized?: () => void | Promise<void>;
};

export type TransportHeadResult = { found: false } | { found: true; versionId: string };
export type TransportPayloadResult = { found: false } | { found: true; plaintext: Uint8Array };
export type TransportPullResult = { found: false } | { found: true; versionId: string; plaintext: Uint8Array };

export type TransportPushResult = { ok: true; versionId: string } | { ok: false; conflict: true; remoteVersionId: string | null };

// Thrown by sync attempts while the app is not connected. Local reads and
// writes never hit the transport, so local-first operation is unaffected;
// sync resumes once a connection is established.
export class OfflineError extends Error {
  constructor() {
    super("not connected to cloud sync");
    this.name = "OfflineError";
  }
}

export class BucketTransportError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = status === 429 || status >= 500) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export type BucketTransportOptions = {
  apiBase: string;
  mfid: string;
  keys: BucketKeys;
  sessionProvider: SessionProvider;
  fetch?: typeof fetch;
};

export class BucketTransport {
  private readonly apiBase: string;
  private readonly mfid: string;
  private readonly keys: BucketKeys;
  private readonly sessionProvider: SessionProvider;
  private readonly fetch: typeof fetch;

  constructor(options: BucketTransportOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, "");
    this.mfid = options.mfid;
    this.keys = options.keys;
    this.sessionProvider = options.sessionProvider;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  async pullHead(wireObjectId: string): Promise<TransportHeadResult> {
    const currentRes = await this.request(() => ({
      url: `${this.objectUrl(wireObjectId)}/current?miss=null`,
      init: { method: "GET" },
    }));
    if (currentRes.status === 404) return { found: false };
    if (!currentRes.ok) throw new BucketTransportError(`pull current failed: ${currentRes.status}`, currentRes.status);
    const body = await readJsonObject(currentRes, "pull current");
    if (!("versionId" in body) || (body.versionId !== null && typeof body.versionId !== "string")) {
      throw new BucketTransportError("pull current returned invalid response", currentRes.status);
    }
    if (!body.versionId) return { found: false };
    return { found: true, versionId: body.versionId };
  }

  async pullPayload(wireObjectId: string, versionId: string): Promise<TransportPayloadResult> {
    const payloadRes = await this.request(() => ({
      url: `${this.objectUrl(wireObjectId)}/versions/${encodeURIComponent(versionId)}/payload`,
      init: { method: "GET" },
    }));
    if (payloadRes.status === 404) return { found: false };
    if (!payloadRes.ok) throw new BucketTransportError(`pull payload failed: ${payloadRes.status}`, payloadRes.status);
    const envelope = new Uint8Array(await payloadRes.arrayBuffer());
    const plaintext = await decryptEnvelope(this.keys, wireObjectId, envelope);
    return { found: true, plaintext };
  }

  async pullCurrent(wireObjectId: string): Promise<TransportPullResult> {
    const head = await this.pullHead(wireObjectId);
    if (!head.found) return { found: false };
    const payload = await this.pullPayload(wireObjectId, head.versionId);
    if (!payload.found) return { found: false };
    return { found: true, versionId: head.versionId, plaintext: payload.plaintext };
  }

  async push(wireObjectId: string, plaintext: Uint8Array, expectedHeadVersionId: string | null): Promise<TransportPushResult> {
    const versionId = crypto.randomUUID();
    const kind = expectedHeadVersionId == null ? "create" : "update";
    const contentHash = fnv1a32Bytes(plaintext);
    const cipherFields = await encryptEnvelopeFields(this.keys, wireObjectId, plaintext);
    const versionPayload = utf8Encode(
      JSON.stringify({
        objectId: wireObjectId,
        versionId,
        kind,
        parentVersionIds: expectedHeadVersionId ? [expectedHeadVersionId] : [],
        ...cipherFields,
      })
    );
    const versionMeta = {
      objectId: wireObjectId,
      versionId,
      parentVersionIds: expectedHeadVersionId ? [expectedHeadVersionId] : [],
      contentHash,
      kind,
      timestamp: Date.now(),
    };
    const headState = {
      headVersionId: versionId,
      historyMap: { [versionId]: expectedHeadVersionId ? [expectedHeadVersionId] : [] },
      fieldSources: {},
    };
    const res = await this.request(() => {
      const form = new FormData();
      form.set("versionMeta", JSON.stringify(versionMeta));
      form.set("headState", JSON.stringify(headState));
      form.set("versionPayload", new Blob([versionPayload.buffer.slice(versionPayload.byteOffset, versionPayload.byteOffset + versionPayload.byteLength) as ArrayBuffer], { type: "application/octet-stream" }));
      if (expectedHeadVersionId != null) form.set("expectedHeadVersionId", expectedHeadVersionId);
      return { url: this.objectUrl(wireObjectId), init: { method: "POST", body: form } };
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { headVersionId?: string | null } | null;
      return { ok: false, conflict: true, remoteVersionId: body?.headVersionId ?? null };
    }
    if (!res.ok) throw new BucketTransportError(`push failed: ${res.status}`, res.status);
    const result = await readJsonObject(res, "push");
    if (result.ok === true) return { ok: true, versionId };
    if (result.ok === false && ["version-mismatch", "conflict"].includes(String(result.reason))) {
      return { ok: false, conflict: true, remoteVersionId: typeof result.headVersionId === "string" ? result.headVersionId : null };
    }
    if (result.ok === false && result.reason === "unauthorized") {
      await this.sessionProvider.onUnauthorized?.();
      throw new BucketTransportError("push was not authorized", 401, false);
    }
    throw new BucketTransportError(`push returned an unconfirmed acknowledgement${typeof result.reason === "string" ? `: ${result.reason}` : ""}`,
      res.status, result.reason !== "invalid-input");
  }

  async listHeads(): Promise<Map<string, string>> {
    const heads = new Map<string, string>();
    const indexRes = await this.request(() => ({ url: `${this.bucketUrl()}/objects:index`, init: { method: "GET" } }));
    if (!indexRes.ok) throw new BucketTransportError(`object index failed: ${indexRes.status}`, indexRes.status);
    const index = await readJsonObject(indexRes, "object index");
    if (!Array.isArray(index.objects)) throw new BucketTransportError("object index returned invalid response", indexRes.status);
    addHeads(heads, index.objects);
    let cursor = typeof index.feedCursor === "string" ? index.feedCursor : null;
    let hasMore = index.hasMoreFeed === true;
    for (let page = 0; hasMore; page += 1) {
      if (page >= MAX_FEED_PAGES) throw new BucketTransportError("feed did not end within page limit", 500);
      const query = new URLSearchParams({ limit: String(FEED_PAGE_LIMIT) });
      if (cursor) query.set("cursor", cursor);
      const feedRes = await this.request(() => ({ url: `${this.bucketUrl()}/feed?${query}`, init: { method: "GET" } }));
      if (!feedRes.ok) throw new BucketTransportError(`feed failed: ${feedRes.status}`, feedRes.status);
      const feed = await readJsonObject(feedRes, "feed");
      if (!Array.isArray(feed.entries)) throw new BucketTransportError("feed returned invalid response", feedRes.status);
      addHeads(heads, feed.entries);
      const next = typeof feed.cursor === "string" ? feed.cursor : null;
      hasMore = feed.hasMore === true && next !== null && next !== cursor;
      cursor = next;
    }
    return heads;
  }

  private bucketUrl(): string {
    const syncRoot = this.apiBase.endsWith("/v1/api/sync") ? this.apiBase : `${this.apiBase}/v1/api/sync`;
    return `${syncRoot}/buckets/${encodeURIComponent(this.keys.bucketId)}`;
  }

  private objectUrl(wireObjectId: string): string {
    return `${this.bucketUrl()}/objects/${encodeURIComponent(wireObjectId)}`;
  }

  private async request(build: () => { url: string; init: RequestInit }): Promise<Response> {
    let session = await this.sessionProvider.getSession();
    let res = await this.send(build(), session);
    if (res.status === 401) {
      void res.body?.cancel().catch(() => {});
      session = await this.sessionProvider.getSession({ forceRefresh: true });
      res = await this.send(build(), session);
      if (res.status === 401) {
        await this.sessionProvider.onUnauthorized?.();
        throw new BucketTransportError("bucket session unauthorized", 401);
      }
    }
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => null) as { code?: string } | null;
      if (REVOKED_AUTHORIZATION_CODES.includes(body?.code || "")) {
        await this.sessionProvider.onUnauthorized?.();
        throw new BucketTransportError("bucket authorization revoked", 403);
      }
    }
    return res;
  }

  private send(req: { url: string; init: RequestInit }, session: SessionCredential): Promise<Response> {
    const headers = new Headers(req.init.headers);
    headers.set("x-myfield-mfid", this.mfid);
    if (session.carrier === "bearer") headers.set("Authorization", `Bearer ${session.token}`);
    return this.fetch(req.url, {
      ...req.init,
      headers,
      ...(session.carrier === "cookie" ? { credentials: "include" as RequestCredentials } : {}),
    });
  }
}

const FEED_PAGE_LIMIT = 100;
const MAX_FEED_PAGES = 10_000;

function addHeads(heads: Map<string, string>, entries: unknown[]): void {
  for (const entry of entries) {
    const row = entry as { objectId?: unknown; versionId?: unknown } | null;
    if (typeof row?.objectId === "string" && typeof row.versionId === "string") heads.set(row.objectId, row.versionId);
  }
}

async function readJsonObject(res: Response, label: string): Promise<Record<string, unknown>> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new BucketTransportError(`${label} returned non-json response`, res.status);
  }
  try {
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new BucketTransportError(`${label} returned invalid json`, res.status);
  }
}
