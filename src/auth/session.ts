import type { AuthInstance } from "./keys.ts";
import { signInstanceChallenge } from "./proof.ts";
import type { CloudSessionCredential, SessionClient } from "../remote/session.ts";
export type { CloudSessionCredential } from "../remote/session.ts";

export async function createSession(input: {
  instance: Pick<AuthInstance, "instanceId" | "signingPrivateKey">;
  mfid: string;
  resourceId: string;
}, client: SessionClient): Promise<CloudSessionCredential> {
  const { instance, mfid, resourceId } = input;
  const identity = { mfid, resourceId, instanceId: instance.instanceId };
  const challenge = await client.createChallenge(identity);
  const proof = await signInstanceChallenge({ instance, mfid, resourceId, challengeId: challenge.challengeId, challenge: challenge.challenge });
  return client.createSession({ ...identity, challengeId: challenge.challengeId, proof });
}
