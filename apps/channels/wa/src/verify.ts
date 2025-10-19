import { env, verifyMetaSignature } from '@buildora/shared';

export class VerificationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'VERIFICATION_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type ChallengeParams = {
  mode?: string | null;
  verifyToken?: string | null;
  challenge?: string | null;
};

export function verifyChallenge(params: ChallengeParams): string {
  const { mode, verifyToken, challenge } = params;
  if (mode !== 'subscribe') {
    throw new VerificationError('Invalid verification mode', 403);
  }
  if (!challenge) {
    throw new VerificationError('Missing challenge parameter', 400);
  }
  if (!env.WA_VERIFY_TOKEN) {
    throw new VerificationError('Verify token not configured', 500);
  }
  if (verifyToken !== env.WA_VERIFY_TOKEN) {
    throw new VerificationError('Verify token mismatch', 403);
  }
  return challenge;
}

export function verifySignature(signature: string | undefined, rawBody: string | undefined): void {
  if (!env.WA_APP_SECRET) {
    throw new VerificationError('WA app secret not configured', 500);
  }

  if (!signature || !rawBody) {
    throw new VerificationError('Missing signature', 401, 'SIGNATURE_MISSING');
  }

  const isValid = verifyMetaSignature(env.WA_APP_SECRET, signature, rawBody);
  if (!isValid) {
    throw new VerificationError('Invalid signature', 401, 'SIGNATURE_INVALID');
  }
}
