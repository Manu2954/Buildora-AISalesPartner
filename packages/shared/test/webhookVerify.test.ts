import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyMetaSignature } from '../src/webhookVerify.js';

describe('verifyMetaSignature', () => {
  const secret = 'super-secret';
  const payload = JSON.stringify({ test: true });
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  const signatureHeader = `sha256=${digest}`;

  it('accepts valid signature', () => {
    expect(verifyMetaSignature(secret, signatureHeader, payload)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(verifyMetaSignature(secret, signatureHeader, payload + 'tampered')).toBe(false);
  });

  it('rejects malformed header', () => {
    expect(verifyMetaSignature(secret, 'md5=abc', payload)).toBe(false);
  });

  it('rejects missing signature', () => {
    expect(verifyMetaSignature(secret, undefined, payload)).toBe(false);
  });
});
