import type { InstanceAuthClient } from "./instance.ts";
import type { StorageAdapter } from "../bucket/store.ts";
import { ClientError } from "../errors.ts";
import { authRecordKeys } from "./store.ts";
import { bucketResourceId } from "./identifiers.ts";

const notAuthorized = (message: string, cause?: unknown) => new ClientError("NOT_AUTHORIZED", message, { cause });

export function createAuthorizationFlow(deps: { getAppId(): string; getBucketId?(): string; persistent?: boolean }) {
  const getBucketId = deps.getBucketId ?? deps.getAppId;
  let closeAuthorization = () => {};
  async function ownCallback(url: URL, storage: StorageAdapter): Promise<boolean> {
    const resourceId = bucketResourceId(getBucketId());
    const requestId = url.searchParams.get("mf_request_id");
    if (!requestId) return false;
    const keys = authRecordKeys(deps.getAppId());
    const pointer = await storage.get<{ resourceId: string; pendingKey: string; requestId: string }>(keys.callback(requestId));
    if (pointer?.resourceId !== resourceId || pointer.requestId !== requestId) return false;
    const pending = await storage.get<{ resourceId: string }>(pointer.pendingKey);
    if (pending && pending.resourceId !== resourceId) return false;
    return true;
  }

  function clearCallbackUrl(url: URL) {
    const current = new URL(window.location.href);
    if (current.searchParams.get("mf_request_id") !== url.searchParams.get("mf_request_id")) return;
    for (const key of ["state", "error", "error_description", "error_uri", "mf_request_id", "mf_result"]) current.searchParams.delete(key);
    const hash = new URLSearchParams(current.hash.slice(1));
    if (hash.has("mf_auth_result")) { hash.delete("mf_auth_result"); current.hash = hash.toString(); }
    window.history.replaceState(null, "", current.href);
  }

  async function handleCallback(auth: InstanceAuthClient, url: URL, signal: AbortSignal, addressBar: boolean) {
    try {
      const result = await auth.handleCallback(url.href);
      signal.throwIfAborted();
      if (result?.result !== "approved") throw notAuthorized(result?.errorDescription || result?.result || "Invalid authorization callback");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ClientError && error.code === "NOT_AUTHORIZED") throw error;
      throw notAuthorized("Invalid authorization callback", error);
    } finally {
      if (addressBar) clearCallbackUrl(url);
    }
  }

  function requestAuthorization(auth: InstanceAuthClient, storage: StorageAdapter, url: string, signal: AbortSignal, setPopup: (popup: Window | null) => void): Promise<void> {
    signal.throwIfAborted();
    const ios = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    const popup = ios ? null : window.open("about:blank", `myfield-sdk-auth:${getBucketId()}`, "popup=yes,width=520,height=720");
    if (!popup && deps.persistent === false) throw new ClientError("INVALID_STATE", "Redirect authorization requires persistent storage");
    setPopup(popup);
    return new Promise<void>((resolve, reject) => {
      let processing = false;
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
        popup?.close();
        closeAuthorization = () => {};
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(signal.reason);
      const onMessage = (event: MessageEvent) => {
        if (!popup || event.source !== popup || ![new URL(url).origin, window.location.origin].includes(event.origin)) return;
        const message = event.data as { type?: string; callbackUrl?: string } | null;
        if (!message || message.type !== "myfield.auth.callback" || typeof message.callbackUrl !== "string") return;
        void (async () => {
          let callbackUrl: URL;
          try { callbackUrl = new URL(message.callbackUrl!); } catch { return; }
          if (!await ownCallback(callbackUrl, storage) || processing || settled) return;
          processing = true;
          await handleCallback(auth, callbackUrl, signal, false);
          finish();
        })().catch(finish);
      };
      window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      closeAuthorization = onAbort;
      if (popup) timer = setInterval(() => {
        if (popup.closed && !processing) finish(notAuthorized("Authorization window closed"));
      }, 250);
      void auth.authorize({ bucketId: getBucketId() }).catch(finish);
    });
  }

  return { ownCallback, handleCallback, requestAuthorization, close: () => closeAuthorization() };
}
