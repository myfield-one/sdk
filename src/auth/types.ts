import type { BucketKeyGrantEnvelope, BucketKeys } from "../bucket/keys.ts";

export type AuthCapability = "read" | "write";

export type InstanceAuthContext = {
  v: 1;
  mfid: string;
  resourceId: string;
  remoteResourceId?: string;
  resourceApiUrl?: string;
  instanceId: string;
  requestId: string;
  authorizedAt: string;
  bucketAccessGrant?: BucketAccessGrant;
};

export type BucketAccess = {
  mfid: string;
  instanceId: string;
  bucketId: string;
  resourceId: string;
  resourceApiUrl?: string;
  capabilities: AuthCapability[];
  grantRecordId: string;
  keys: BucketKeys;
};

export type AuthCallbackResult = {
  requestId: string;
  state: string;
  result: "approved" | "denied" | "error";
  resourceId?: string;
  error?: string;
  errorDescription?: string;
};

export type BucketAccessGrant = {
  v: 1;
  grantRecordId: string;
  mfid: string;
  resourceId: string;
  instanceId: string;
  issuedAt: string;
  keyId: string;
  capabilities: AuthCapability[];
  envelope: BucketKeyGrantEnvelope;
};
