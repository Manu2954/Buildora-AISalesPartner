import { Queue, QueueScheduler, Worker } from 'bullmq';
import type IORedis from 'ioredis';

import { prisma } from '@buildora/shared';

import { JOURNEY_QUEUE, type JourneyJob } from './queues.js';
import { processJourney } from './journeyMachine.js';

type JourneyWorkerHandle = {
  worker: Worker<JourneyJob>;
  queue: Queue<JourneyJob>;
  scheduler: QueueScheduler;
  schedule: (leadId: string, options?: { delayMs?: number; force?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

export function createJourneyWorker(connection: IORedis): JourneyWorkerHandle {
  const scheduler = new QueueScheduler(JOURNEY_QUEUE, { connection });
  const queue = new Queue<JourneyJob>(JOURNEY_QUEUE, { connection });

  const worker = new Worker<JourneyJob>(
    JOURNEY_QUEUE,
    async (job) => {
      const result = await processJourney(job.data.leadId, { force: job.data.force });
      if (result.nextActionAt) {
        await scheduleJourney(queue, job.data.leadId, {
          delayMs: Math.max(0, result.nextActionAt.getTime() - Date.now())
        });
      }
    },
    {
      connection,
      concurrency: 1
    }
  );

  worker.on('completed', (job) => {
    if (job) {
      console.log(`[assistant] Journey job ${job.id} completed for lead ${job.data.leadId}`);
    }
  });

  worker.on('failed', (job, error) => {
    console.error(
      `[assistant] Journey job ${job?.id ?? 'unknown'} failed for lead ${job?.data.leadId ?? 'unknown'}`,
      error
    );
  });

  void bootstrapPendingJourneys(queue);

  return {
    worker,
    queue,
    scheduler,
    schedule: (leadId, options) => scheduleJourney(queue, leadId, options),
    close: async () => {
      await worker.close();
      await queue.close();
      await scheduler.close();
    }
  };
}

export async function scheduleJourney(
  queue: Queue<JourneyJob>,
  leadId: string,
  options: { delayMs?: number; force?: boolean } = {}
): Promise<void> {
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const jobId = leadId;

  const existing = await queue.getJob(jobId);
  if (existing) {
    await existing.remove();
  }

  await queue.add(
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

async function bootstrapPendingJourneys(queue: Queue<JourneyJob>): Promise<void> {
  try {
    const now = Date.now();
    const journeys = await prisma.leadJourney.findMany({
      where: {
        nextActionAt: {
          not: null
        }
      },
      select: {
        leadId: true,
        nextActionAt: true
      }
    });

    await Promise.all(
      journeys.map((journey) => {
        if (!journey.nextActionAt) {
          return Promise.resolve();
        }
        const delayMs = Math.max(0, journey.nextActionAt.getTime() - now);
        return scheduleJourney(queue, journey.leadId, { delayMs });
      })
    );
  } catch (error) {
    console.error('[assistant] Failed to bootstrap journey queue', error);
  }
}
