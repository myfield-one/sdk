import { ClientError } from "../errors.ts";
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

export type InstanceKey = Omit<AuthInstance, "v">;

export function toInstanceKey(value: AuthInstance): InstanceKey {
  return { instanceId: value.instanceId, signingPublicJwk: { ...value.signingPublicJwk },
    signingPrivateKey: value.signingPrivateKey, wrappingPublicJwk: { ...value.wrappingPublicJwk },
    wrappingPrivateKey: value.wrappingPrivateKey, createdAt: value.createdAt };
}

export async function validateInstanceKey(value: InstanceKey): Promise<AuthInstance> {
  const invalid = (cause?: unknown) => new ClientError("INVALID_INPUT", "Invalid instance key", { cause });
  try {
    if (!value || typeof value !== "object" || typeof value.createdAt !== "string"
      || !value.createdAt.endsWith("Z") || !Number.isFinite(Date.parse(value.createdAt))) throw invalid();
    value = { ...value, signingPublicJwk: { ...value.signingPublicJwk }, wrappingPublicJwk: { ...value.wrappingPublicJwk } };
    const { signingPrivateKey: sign, wrappingPrivateKey: wrap } = value;
    for (const [key, name, usage] of [[sign, "ECDSA", "sign"], [wrap, "ECDH", "deriveBits"]] as const) {
      if (!(key instanceof CryptoKey) || key.type !== "private" || key.extractable || key.algorithm.name !== name
        || (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" || !key.usages.includes(usage)) throw invalid();
    }
    if (value.instanceId !== await deriveInstanceId(value.signingPublicJwk)) throw invalid();
    const publicSign = await crypto.subtle.importKey("jwk", value.signingPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sign, challenge);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicSign, signature, challenge)) throw invalid();
    const publicWrap = await crypto.subtle.importKey("jwk", value.wrappingPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const left = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral.publicKey }, wrap, 256));
    const right = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicWrap }, ephemeral.privateKey, 256));
    if (!left.every((byte, i) => byte === right[i])) throw invalid();
    return { v: 1, instanceId: value.instanceId, signingPublicJwk: { ...value.signingPublicJwk }, signingPrivateKey: sign,
      wrappingPublicJwk: { ...value.wrappingPublicJwk }, wrappingPrivateKey: wrap, createdAt: value.createdAt };
  } catch (cause) { throw cause instanceof ClientError ? cause : invalid(cause); }
}
