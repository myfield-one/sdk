export type InstanceProof = {
  type: "instance.es256";
  instanceId: string;
  alg: "ES256";
  signedAt: string;
  signature: string;
};

export type CloudSessionCredential =
  | { carrier: "bearer"; token: string; expiresAt: string }
  | { carrier: "cookie"; expiresAt: string };

type SessionIdentity = { mfid: string; resourceId: string; instanceId: string };
type Challenge = { challengeId: string; challenge: string };
type PostJson = <T>(path: string, body: unknown) => Promise<T>;

export function createSessionClient(postJson: PostJson) {
  return {
    createChallenge(identity: SessionIdentity): Promise<Challenge> {
      return postJson("/v1/api/auth/instance-challenge", identity);
    },
    async createSession(input: SessionIdentity & { challengeId: string; proof: InstanceProof }): Promise<CloudSessionCredential> {
      const session = await postJson<{ credential: CloudSessionCredential }>("/v1/api/auth/instance-session", {
        ...input, credentialCarrier: "bearer",
      });
      return session.credential;
    },
  };
}

export type SessionClient = ReturnType<typeof createSessionClient>;
