import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { env } from '@buildora/shared';

export type DialogueTurnPayload = {
  conversationId: string;
  messageId: string;
  leadId: string;
  contactId: string;
};

const connection = new IORedis(env.REDIS_URL);

export const dialogueQueue = new Queue<DialogueTurnPayload>('dialogue', {
  connection
});

type JourneyJob = {
  leadId: string;
  force?: boolean;
};

export const journeyQueue = new Queue<JourneyJob>('journey', {
  connection
});

export async function enqueueDialogueTurn(payload: DialogueTurnPayload): Promise<void> {
  await dialogueQueue.add('turn', payload, {
    removeOnComplete: true,
    removeOnFail: 100
  });
}

export async function scheduleJourneyTick(
  leadId: string,
  options: { delayMs?: number; force?: boolean } = {}
): Promise<void> {
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const jobId = leadId;
  const existing = await journeyQueue.getJob(jobId);
  if (existing) {
    await existing.remove();
  }
  await journeyQueue.add(
    'tick',
    {
      leadId,
      force: options.force ?? false
    },
    {
      jobId,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: 100
    }
  );
}

export async function shutdownQueue(): Promise<void> {
  await dialogueQueue.close();
  await journeyQueue.close();
  await connection.quit();
}
