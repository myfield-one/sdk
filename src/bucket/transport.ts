// HTTP transport for the open bucket surface: GET current, GET version
// payload, and object CAS write. Session credentials come from the auth
// layer; a 401 triggers one forced session refresh and retry before the
// error escalates (the auth layer decides whether that means disconnected).

import { fnv1a32Bytes, utf8Encode } from "../internal/encoding.ts";
import { decryptEnvelope, encryptEnvelopeFields } from "./crypto.ts";
import type { BucketKeys } from "./keys.ts";

export type SessionCredential = { carrier: "bearer"; token: string } | { carrier: "cookie" };

export type SessionProvider = {
  getSession(options?: { forceRefresh?: boolean }): Promise<SessionCredential>;
  onUnauthorized?: () => void;
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

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export type BucketTransportOptions = {
  apiBase: string;
  mfid: string;
  keys: BucketKeys;
  sessionProvider: SessionProvider;
};

export class BucketTransport {
  private readonly apiBase: string;
  private readonly mfid: string;
  private readonly keys: BucketKeys;
  private readonly sessionProvider: SessionProvider;

  constructor(options: BucketTransportOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, "");
    this.mfid = options.mfid;
    this.keys = options.keys;
    this.sessionProvider = options.sessionProvider;
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
    return { ok: true, versionId };
  }

  private objectUrl(wireObjectId: string): string {
    const syncRoot = this.apiBase.endsWith("/v1/api/sync") ? this.apiBase : `${this.apiBase}/v1/api/sync`;
    return `${syncRoot}/buckets/${encodeURIComponent(this.keys.bucketId)}/objects/${encodeURIComponent(wireObjectId)}`;
  }

  private async request(build: () => { url: string; init: RequestInit }): Promise<Response> {
    let session = await this.sessionProvider.getSession();
    let res = await this.send(build(), session);
    if (res.status === 401) {
      session = await this.sessionProvider.getSession({ forceRefresh: true });
      res = await this.send(build(), session);
      if (res.status === 401) {
        this.sessionProvider.onUnauthorized?.();
        throw new BucketTransportError("bucket session unauthorized", 401);
      }
    }
    return res;
  }

  private send(req: { url: string; init: RequestInit }, session: SessionCredential): Promise<Response> {
    const headers = new Headers(req.init.headers);
    headers.set("x-myfield-mfid", this.mfid);
    if (session.carrier === "bearer") headers.set("Authorization", `Bearer ${session.token}`);
    return fetch(req.url, {
      ...req.init,
      headers,
      ...(session.carrier === "cookie" ? { credentials: "include" as RequestCredentials } : {}),
    });
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
