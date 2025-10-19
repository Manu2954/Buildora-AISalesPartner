import { DateTime } from 'luxon';

import { env } from './env.js';

const DAILY_LIMIT = 1;
const TEN_DAY_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_DAY_MS = 10 * DAY_MS;
const ENGAGEMENT_START_HOUR = 10;
const ENGAGEMENT_END_HOUR = 19;

type RateLimitResult = {
  allowed: boolean;
  reason?: string;
  remainingDaily: number;
  remainingTenDay: number;
};

const tokenStore = new Map<string, number[]>();

export function guardQuietHours(now: Date = new Date()): boolean {
  const local = DateTime.fromJSDate(now, { zone: env.TIMEZONE ?? 'Asia/Kolkata' });
  const hour = local.hour + local.minute / 60;
  return hour >= ENGAGEMENT_START_HOUR && hour < ENGAGEMENT_END_HOUR;
}

export function rateLimit(key: string, now: Date = new Date()): RateLimitResult {
  const timestamps = (tokenStore.get(key) ?? []).filter((ts) => now.getTime() - ts < TEN_DAY_MS);
  const dailyCount = timestamps.filter((ts) => now.getTime() - ts < DAY_MS).length;

  if (dailyCount >= DAILY_LIMIT) {
    return {
      allowed: false,
      reason: 'Daily proactive limit reached',
      remainingDaily: 0,
      remainingTenDay: Math.max(0, TEN_DAY_LIMIT - timestamps.length)
    };
  }
  if (timestamps.length >= TEN_DAY_LIMIT) {
    return {
      allowed: false,
      reason: '10-day proactive limit reached',
      remainingDaily: Math.max(0, DAILY_LIMIT - dailyCount),
      remainingTenDay: 0
    };
  }

  const updated = [...timestamps, now.getTime()];
  tokenStore.set(key, updated);

  return {
    allowed: true,
    remainingDaily: Math.max(0, DAILY_LIMIT - (dailyCount + 1)),
    remainingTenDay: Math.max(0, TEN_DAY_LIMIT - updated.length)
  };
}

export const __internal = {
  clearRateLimit() {
    tokenStore.clear();
  }
};
