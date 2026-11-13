import { bytesToB64url, normalizeIsoDateTime, stableStringify, utf8Encode } from "../internal/encoding.ts";
import type { AuthInstance } from "./keys.ts";
import type { InstanceProof } from "../remote/session.ts";

export async function signInstanceChallenge(input: {
  instance: Pick<AuthInstance, "instanceId" | "signingPrivateKey">;
  challenge: string;
  mfid: string;
  resourceId: string;
  challengeId?: string;
  signedAt?: string;
}): Promise<InstanceProof> {
  const signedAt = normalizeIsoDateTime(input.signedAt) || new Date().toISOString();
  const payload = stableStringify({
    v: 1,
    type: "instance-proof",
    instanceId: input.instance.instanceId,
    challenge: input.challenge,
    challengeId: input.challengeId || "",
    mfid: input.mfid,
    resourceId: input.resourceId,
    signedAt,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.instance.signingPrivateKey, utf8Encode(payload));
  return { type: "instance.es256", instanceId: input.instance.instanceId, alg: "ES256", signedAt, signature: bytesToB64url(new Uint8Array(signature)) };
}
