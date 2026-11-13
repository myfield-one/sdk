import { ClientError } from "../errors.ts";
import { invalidResponse, isRecord } from "./http.ts";

export type FeedHint = { objectId: string; versionId: string };

export function isFeedHint(value: unknown): value is FeedHint {
  return isRecord(value) && typeof value.objectId === "string" && value.objectId.length > 0
    && typeof value.versionId === "string" && value.versionId.length > 0;
}

export async function openFeedStream(response: Response, signal?: AbortSignal): Promise<AsyncGenerator<FeedHint>> {
  const stream = readFeedStream(response, signal);
  await stream.next();
  // The only undefined yield is the readiness marker consumed above.
  return stream as AsyncGenerator<FeedHint>;
}

async function* readFeedStream(response: Response, signal?: AbortSignal): AsyncGenerator<FeedHint | undefined> {
  if (!response.body || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
    await response.body?.cancel().catch(() => {});
    throw invalidResponse(response, "Expected an event stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "", event = "", data: string[] = [], ready = false;
  try {
    signal?.throwIfAborted();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (cause) {
        signal?.throwIfAborted();
        throw new ClientError("NETWORK_ERROR", "Feed stream interrupted", { retryable: true, cause });
      }
      signal?.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer)) !== null) {
        if (!chunk.done && match.index === buffer.length - 1 && match[0] === "\r") break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          if (event === "sync-ready" && data.length && !ready) {
            ready = true;
            yield undefined;
          } else if (event === "sync-feed" && data.length) {
            if (!ready) throw invalidResponse(response, "Feed change received before readiness");
            let value: unknown;
            try { value = JSON.parse(data.join("\n")); }
            catch (cause) { throw invalidResponse(response, "Invalid feed event", cause); }
            const entries: unknown[] = isRecord(value) && Array.isArray(value.entries) ? value.entries : [value];
            if (!entries.every(isFeedHint)) throw invalidResponse(response, "Invalid feed hint");
            for (const entry of entries) {
              signal?.throwIfAborted();
              if (isFeedHint(entry)) yield { objectId: entry.objectId, versionId: entry.versionId };
            }
          }
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
      if (chunk.done) {
        if (!ready) throw invalidResponse(response, "Feed ended before readiness");
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
