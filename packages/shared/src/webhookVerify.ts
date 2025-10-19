import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Meta (Facebook/WhatsApp) webhook request signature.
 *
 * @param appSecret - The app secret configured in Meta developer console.
 * @param signatureHeader - The value of the `x-hub-signature-256` header.
 * @param payload - Raw request payload used to compute the digest.
 */
export function verifyMetaSignature(
  appSecret: string,
  signatureHeader: string | undefined,
  payload: string | Buffer
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const [scheme, signature] = signatureHeader.split('=');
  if (!scheme || !signature || scheme !== 'sha256') {
    return false;
  }

  const expected = createHmac('sha256', appSecret).update(payload).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function verifyInternalSignature(
  secret: string,
  signatureHeader: string | undefined,
  payload: string | Buffer
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const [scheme, signature] = signatureHeader.split('=');
  if (!scheme || !signature || scheme !== 'sha256') {
    return false;
  }

  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
