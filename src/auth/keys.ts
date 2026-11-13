import { sha256Hex, stableStringify } from "../internal/encoding.ts";

export type AuthInstance = {
  v: 1;
  instanceId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  wrappingPublicJwk: JsonWebKey;
  wrappingPrivateKey: CryptoKey;
  createdAt: string;
};

export async function createInstanceKey(): Promise<AuthInstance> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const wrapping = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const signingPublicJwk = (await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey;
  const wrappingPublicJwk = (await crypto.subtle.exportKey("jwk", wrapping.publicKey)) as JsonWebKey;
  return {
    v: 1,
    instanceId: await deriveInstanceId(signingPublicJwk),
    signingPublicJwk,
    signingPrivateKey: signing.privateKey,
    wrappingPublicJwk,
    wrappingPrivateKey: wrapping.privateKey,
    createdAt: new Date().toISOString(),
  };
}

async function deriveInstanceId(signingPublicJwk: JsonWebKey): Promise<string> {
  const digest = await sha256Hex(stableStringify(jwkCore(signingPublicJwk)));
  return `inst_${digest.slice(0, 32)}`;
}

function jwkCore(jwk: JsonWebKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["kty", "crv", "x", "y", "kid", "alg", "use"] as const) {
    const value = (jwk as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
