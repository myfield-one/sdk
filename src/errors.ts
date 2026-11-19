// Public error classes. Exported unprefixed — the @myfield/sdk package
// scope is the namespace; `error.name` matches the class name.

/** A Local sync operation requires an active connection.
 * @public
 */
export class NotConnectedError extends Error {
  constructor() {
    super("bucket is not connected; call connect() first");
    this.name = "NotConnectedError";
  }
}

export const REVOKED_AUTHORIZATION_CODES: readonly string[] = ["GRANT_REVOKED", "GRANT_NOT_FOUND", "AUTH_FAILED"];

/** HTTP diagnostics, retry information, payload limit and original cause.
 * @public
 */
export type ClientErrorOptions = {
  status?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  maxBytes?: number;
  cause?: unknown;
};

/** Machine-readable SDK failure with optional HTTP and retry diagnostics.
 * @public
 */
export class ClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly maxBytes?: number;

  constructor(code: string, message: string, options: ClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ClientError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.maxBytes = options.maxBytes;
  }
}
