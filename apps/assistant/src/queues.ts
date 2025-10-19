import IORedis from 'ioredis';

import { env } from '@buildora/shared';

export const DIALOGUE_QUEUE = 'dialogue';
export const JOURNEY_QUEUE = 'journey';

export type DialogueJob = {
  conversationId: string;
  messageId: string;
  leadId: string;
  contactId: string;
};

export type JourneyJob = {
  leadId: string;
  force?: boolean;
};

export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL);
}
