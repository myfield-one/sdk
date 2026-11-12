import { ClientError } from "../errors.ts";

export type RequestOptions = { signal?: AbortSignal };
export type RemoteRequest = (path: string, init?: RequestInit) => Promise<Response>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
}

export function invalidResponse(response: Response, message = "Invalid protocol response", cause?: unknown): ClientError {
  return new ClientError("INVALID_RESPONSE", message, {
    status: response.status, requestId: response.headers.get("x-request-id") ?? undefined, cause,
  });
}

function networkError(cause: unknown, signal?: AbortSignal | null): never {
  signal?.throwIfAborted();
  throw new ClientError("NETWORK_ERROR", "Network request failed", { retryable: true, cause });
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); }
  catch (cause) {
    signal?.throwIfAborted();
    if (!(cause instanceof SyntaxError)) return networkError(cause, signal);
    throw invalidResponse(response, "Invalid JSON response", cause);
  }
  signal?.throwIfAborted();
  if (!isRecord(value)) throw invalidResponse(response);
  return value;
}

export function createHttpRequest(options: { apiBase: string; fetch?: typeof globalThis.fetch }) {
  requireString(options.apiBase, "apiBase");
  let base: URL;
  try { base = new URL(options.apiBase); }
  catch (cause) { throw new ClientError("INVALID_INPUT", "apiBase must be an HTTP(S) origin", { cause }); }
  if (!["http:", "https:"].includes(base.protocol) || base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new ClientError("INVALID_INPUT", "apiBase must be an HTTP(S) origin without a path, query, fragment or credentials");
  }
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof fetch !== "function") throw new ClientError("INVALID_INPUT", "fetch must be a function");
  return async (path: string, init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted();
    let response: Response;
    try { response = await fetch(new URL(path, base).href, { ...init, credentials: "omit" }); }
    catch (cause) { return networkError(cause, init.signal); }
    if (response.ok) return response;
    let body: Record<string, unknown> = {};
    try {
      const value: unknown = await response.json();
      if (isRecord(value)) body = value;
    } catch { init.signal?.throwIfAborted(); }
    const details = isRecord(body.details) ? body.details : {};
    const retry = response.headers.get("retry-after");
    const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
    const date = retry === null ? NaN : Date.parse(retry);
    const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
    throw new ClientError(typeof body.code === "string" && body.code ? body.code : "HTTP_ERROR",
      typeof body.message === "string" && body.message ? body.message
        : typeof body.error === "string" && body.error ? body.error : `HTTP ${response.status}`, {
        status: response.status,
        requestId: typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id") ?? undefined,
        retryable: typeof details.retryable === "boolean" ? details.retryable
          : response.status === 408 || response.status === 429 || response.status >= 500,
        retryAfterMs,
        maxBytes: typeof details.maxBytes === "number" ? details.maxBytes : undefined,
      });
  };
}
