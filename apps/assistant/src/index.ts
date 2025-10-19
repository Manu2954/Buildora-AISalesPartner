import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Server } from 'node:http';

import { Worker } from 'bullmq';

import {
  env,
  createLogger,
  metricsSnapshot,
  errorRate,
  prisma,
  Prisma
} from '@buildora/shared';

import { createJourneyWorker } from './journeyWorker.js';
import { createRedisConnection, DIALOGUE_QUEUE } from './queues.js';
import { processTurn, type DialogueTurnPayload } from './turn.js';

const PORT = Number(process.env.PORT ?? 4001);

const redisConnection = createRedisConnection();
const journeyHandle = createJourneyWorker(redisConnection);

const dialogueWorker = new Worker<DialogueTurnPayload>(
  DIALOGUE_QUEUE,
  async (job) => {
    const log = createLogger({ component: 'assistant-worker', conversationId: job.data.conversationId });
    log.info('processing dialogue job');
    await processTurn(job.data);
  },
  {
    connection: redisConnection,
    concurrency: 1
  }
);

dialogueWorker.on('completed', (job) => {
  createLogger({ component: 'assistant-worker', jobId: job?.id }).info('dialogue job completed');
});

dialogueWorker.on('failed', (job, error) => {
  errorRate.inc({ component: 'assistant:dialogue' });
  createLogger({ component: 'assistant-worker', jobId: job?.id }).error({ error }, 'dialogue job failed');
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (url.pathname === '/metrics') {
    void metricsSnapshot()
      .then((output) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(output);
      })
      .catch((error) => {
        errorRate.inc({ component: 'assistant:metrics' });
        createLogger({ component: 'assistant-server' }).error({ error }, 'failed to produce metrics');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'metrics_unavailable' }));
      });
    return;
  }

  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    setCors(res);
    return void handleConversationsList(res);
  }

  const conversationDetailMatch = url.pathname.match(/^\/api\/conversations\/([^\/]+)$/);
  if (conversationDetailMatch && req.method === 'GET') {
    setCors(res);
    return void handleConversationDetail(conversationDetailMatch[1], res);
  }

  const suppressMatch = url.pathname.match(/^\/api\/conversations\/([^\/]+)\/suppress$/);
  if (suppressMatch && req.method === 'POST') {
    setCors(res);
    const body = await readJsonBody(req).catch((error) => {
      createLogger({ component: 'assistant-api' }).warn({ error }, 'invalid JSON body');
      sendJson(res, 400, { error: 'invalid_body' });
      return null;
    });
    if (!body) return;
    return void handleSuppressionToggle(suppressMatch[1], body, res);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('assistant ready');
});

let httpServer: Server;
let shuttingDown = false;

try {
  httpServer = server.listen(PORT, () => {
    console.log(`[assistant] listening on :${PORT} (tz: ${env.TIMEZONE})`);
  });
} catch (error) {
  createLogger({ component: 'assistant-server' }).error({ error }, 'failed to start http server');
  await cleanupAndExit(1);
  throw error;
}

const shutdownHandler = () => {
  void cleanupAndExit(0);
};

process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

async function cleanupAndExit(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  createLogger({ component: 'assistant-server' }).info('shutting down');
  try {
    await dialogueWorker.close();
    await journeyHandle.close();
    await redisConnection.quit();
  } catch (error) {
    createLogger({ component: 'assistant-server' }).error({ error }, 'error while closing worker resources');
  }

  if (httpServer) {
    httpServer.close(() => {
      process.exit(code);
    });
  } else {
    process.exit(code);
  }
}

function setCors(res: ServerResponse) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleConversationsList(res: ServerResponse) {
  const conversations = await prisma.conversation.findMany({
    orderBy: { lastActivity: 'desc' },
    take: 25,
    include: {
      Lead: {
        select: {
          id: true,
          status: true,
          intentScore: true,
          journey: {
            select: {
              manualSuppressedUntil: true,
              state: true,
              nextActionAt: true
            }
          },
          contacts: {
            select: {
              id: true,
              name: true,
              phone: true,
              role: true
            },
            take: 1
          }
        }
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  const items = conversations.map((conversation) => ({
    id: conversation.id,
    leadId: conversation.leadId,
    status: conversation.Lead?.status ?? 'unknown',
    intentScore: conversation.Lead?.intentScore ?? 0,
    contactName: conversation.Lead?.contacts?.[0]?.name ?? 'Unknown contact',
    contactId: conversation.Lead?.contacts?.[0]?.id ?? null,
    lastMessage: conversation.messages[0]?.body ?? '',
    lastMessageAt: conversation.messages[0]?.createdAt ?? conversation.updatedAt,
    manualSuppressedUntil: conversation.Lead?.journey?.manualSuppressedUntil ?? null,
    journeyState: conversation.Lead?.journey?.state ?? null,
    nextActionAt: conversation.Lead?.journey?.nextActionAt ?? null
  }));

  sendJson(res, 200, { conversations: items });
}

async function handleConversationDetail(conversationId: string, res: ServerResponse) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      Lead: {
        include: {
          journey: true,
          contacts: true
        }
      }
    }
  });

  if (!conversation || !conversation.Lead) {
    sendJson(res, 404, { error: 'conversation_not_found' });
    return;
  }

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: 100
  });

  sendJson(res, 200, {
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      leadId: conversation.leadId,
      status: conversation.Lead.status,
      intentScore: conversation.Lead.intentScore,
      journey: conversation.Lead.journey,
      contacts: conversation.Lead.contacts
    },
    messages
  });
}

async function handleSuppressionToggle(
  conversationId: string,
  body: { suppress?: boolean },
  res: ServerResponse
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { leadId: true }
  });

  if (!conversation) {
    sendJson(res, 404, { error: 'conversation_not_found' });
    return;
  }

  const suppress = Boolean(body.suppress);
  const now = new Date();
  const until = suppress ? new Date(now.getTime() + 48 * 60 * 60 * 1000) : null;

  const journey = await prisma.leadJourney.upsert({
    where: { leadId: conversation.leadId },
    update: {
      manualSuppressedUntil: until,
      state: suppress ? Prisma.JourneyState.PAUSE : Prisma.JourneyState.CONSENT_CHECK,
      nextActionAt: suppress ? until : now,
      lastError: suppress ? 'Manual suppression' : null
    },
    create: {
      leadId: conversation.leadId,
      state: suppress ? Prisma.JourneyState.PAUSE : Prisma.JourneyState.CONSENT_CHECK,
      manualSuppressedUntil: until,
      nextActionAt: suppress ? until : now,
      lastError: suppress ? 'Manual suppression' : null
    }
  });

  if (suppress) {
    await journeyHandle.schedule(conversation.leadId, {
      delayMs: until ? until.getTime() - now.getTime() : 0,
      force: true
    });
  } else {
    await journeyHandle.schedule(conversation.leadId, { delayMs: 0, force: true });
  }

  createLogger({ component: 'assistant-api', leadId: conversation.leadId }).info(
    { suppress, manualSuppressedUntil: journey.manualSuppressedUntil },
    'updated suppression flag'
  );

  sendJson(res, 200, {
    suppress,
    manualSuppressedUntil: journey.manualSuppressedUntil,
    state: journey.state,
    nextActionAt: journey.nextActionAt
  });
}
