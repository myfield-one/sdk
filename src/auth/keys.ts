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

export async function deriveInstanceId(signingPublicJwk: JsonWebKey): Promise<string> {
  const core = {
    kty: String(signingPublicJwk.kty || ""),
    crv: String(signingPublicJwk.crv || ""),
    x: String(signingPublicJwk.x || ""),
    y: String(signingPublicJwk.y || ""),
  };
  const digest = await sha256Hex(stableStringify(core));
  return `inst_${digest.slice(0, 32)}`;
}
