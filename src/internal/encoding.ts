const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_DECODE = new Map([...B64URL_ALPHABET].map((char, index) => [char, index]));

export function bytesToB64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64URL_ALPHABET[(triple >> 18) & 63];
    out += B64URL_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL_ALPHABET[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL_ALPHABET[triple & 63];
  }
  return out;
}

export function b64urlToBytes(value: string): Uint8Array {
  const safe = String(value || "").trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  if (safe.length % 4 === 1) throw new Error("invalid base64url length");
  const out: number[] = [];
  for (let i = 0; i < safe.length; i += 4) {
    const chunk = safe.slice(i, i + 4);
    const values = [...chunk].map((char) => {
      const decoded = B64URL_DECODE.get(char);
      if (decoded === undefined) throw new Error("invalid base64url character");
      return decoded;
    });
    const a = values[0] ?? 0;
    const b = values[1] ?? 0;
    const c = values[2] ?? 0;
    const d = values[3] ?? 0;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    out.push((triple >> 16) & 255);
    if (values.length > 2) out.push((triple >> 8) & 255);
    if (values.length > 3) out.push(triple & 255);
  }
  return new Uint8Array(out);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function randomId(prefix: string, byteLength = 16): string {
  return `${prefix}_${bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)))}`;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

export function fnv1a32Bytes(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

export function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const safe = value.trim();
  if (!safe) return null;
  const date = new Date(/Z|[+-]\d{2}:\d{2}$/.test(safe) ? safe : `${safe}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
