import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Guardrails', () => {
  beforeEach(async () => {
    const { __internal } = await import('../src/guardrails.js');
    __internal.clearRateLimit();
  });

  afterEach(async () => {
    const { __internal } = await import('../src/guardrails.js');
    __internal.clearRateLimit();
  });

  it('permits interactions within engagement window', async () => {
    const { guardQuietHours } = await import('../src/guardrails.js');
    const allowedTime = new Date('2024-04-10T06:00:00Z'); // 11:30 IST
    const outsideTime = new Date('2024-04-09T21:00:00Z'); // 02:30 IST

    expect(guardQuietHours(allowedTime)).toBe(true);
    expect(guardQuietHours(outsideTime)).toBe(false);
  });

  it('enforces proactive rate limits', async () => {
    const { rateLimit } = await import('../src/guardrails.js');
    const base = new Date('2024-04-10T06:30:00Z');

    const first = rateLimit('contact-1', base);
    expect(first.allowed).toBe(true);
    expect(first.remainingDaily).toBe(0);

    const second = rateLimit('contact-1', new Date(base.getTime() + 60 * 60 * 1000));
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/Daily/);

    const third = rateLimit(
      'contact-1',
      new Date(base.getTime() + 2 * 24 * 60 * 60 * 1000)
    );
    expect(third.allowed).toBe(true);
    const fourth = rateLimit(
      'contact-1',
      new Date(base.getTime() + 4 * 24 * 60 * 60 * 1000)
    );
    expect(fourth.allowed).toBe(true);

    const fifth = rateLimit(
      'contact-1',
      new Date(base.getTime() + 5 * 24 * 60 * 60 * 1000)
    );
    expect(fifth.allowed).toBe(false);
    expect(fifth.reason).toMatch(/10-day/);
  });
});
