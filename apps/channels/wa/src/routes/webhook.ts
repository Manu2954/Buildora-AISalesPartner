import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';

import {
  Prisma,
  prisma,
  createLogger,
  messagesInboundTotal,
  errorRate
} from '@buildora/shared';

import { enqueueDialogueTurn, scheduleJourneyTick } from '../queue.js';
import { VerificationError, verifyChallenge, verifySignature } from '../verify.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const challenge = verifyChallenge({
      mode: req.query['hub.mode']?.toString() ?? null,
      verifyToken: req.query['hub.verify_token']?.toString() ?? null,
      challenge: req.query['hub.challenge']?.toString() ?? null
    });
    res.status(200).send(challenge);
  } catch (error) {
    if (error instanceof VerificationError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  }
});

router.post('/', async (req: RequestWithRawBody, res: Response, next: NextFunction) => {
  try {
    verifySignature(req.get('x-hub-signature-256') ?? undefined, req.rawBody);

    const payload = req.body as WebhookPayload;
    if (!payload?.entry?.length) {
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const inboundMessages = extractInboundMessages(payload);
    if (inboundMessages.length === 0) {
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const processedIds: string[] = [];
    for (const message of inboundMessages) {
      const processedId = await handleInboundMessage(message).catch((error) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // Duplicate message ID, treat as processed.
          return message.message.id;
        }
        throw error;
      });
      if (processedId) {
        processedIds.push(processedId);
      }
    }

    res.status(202).json({ status: 'queued', processed: processedIds.length });
  } catch (error) {
    if (error instanceof VerificationError) {
      errorRate.inc({ component: 'webhook:signature' });
      createLogger({ component: 'wa-webhook' }).warn({ error: error.message }, 'verification failed');
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }
});

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  errorRate.inc({ component: 'webhook:unhandled' });
  createLogger({ component: 'wa-webhook' }).error({ error }, 'webhook handler error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
});

export const webhookRouter = router;

type RequestWithRawBody = Request & { rawBody?: string };

type WebhookPayload = {
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id: string }>;
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

type WhatsAppMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    nfm_reply?: { response_json?: string };
  };
  image?: { caption?: string };
  audio?: { id?: string };
  video?: { caption?: string };
  document?: { filename?: string };
  [key: string]: unknown;
};

type InboundPayload = {
  message: WhatsAppMessage;
  phoneNumberId?: string;
};

async function handleInboundMessage(payload: InboundPayload): Promise<string> {
  const { message } = payload;
  const fromPhone = normalizePhone(message.from);
  const timestampMs = message.timestamp ? Number.parseInt(message.timestamp, 10) * 1000 : Date.now();
  const occurredAt = Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date();
  const messageBody = extractMessageBody(message);

  const { contact, lead } = await resolveContact(fromPhone);
  const conversation = await resolveConversation(lead.id, occurredAt);
  const log = createLogger({ component: 'wa-webhook', leadId: lead.id, conversationId: conversation.id });

  const messageMeta = {
    ...message,
    phone_number_id: payload.phoneNumberId ?? null
  } as Prisma.JsonValue;

  const createdMessage = await prisma.message.create({
    data: {
      id: message.id,
      conversationId: conversation.id,
      direction: 'inbound',
      body: messageBody,
      meta: messageMeta,
      createdAt: occurredAt
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastActivity: occurredAt,
      open: true
    }
  });

  await enqueueDialogueTurn({
    conversationId: conversation.id,
    messageId: createdMessage.id,
    leadId: lead.id,
    contactId: contact.id
  });

  await recordJourneyUserActivity(lead.id, occurredAt);

  messagesInboundTotal.inc({ channel: 'whatsapp' });
  log.info(
    {
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: createdMessage.id
    },
    'processed inbound message'
  );

  return createdMessage.id;
}

function extractInboundMessages(payload: WebhookPayload): InboundPayload[] {
  const results: InboundPayload[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') {
        continue;
      }
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const messages = change.value?.messages ?? [];
      for (const message of messages) {
        if (message.from && message.id) {
          results.push({ message, phoneNumberId });
        }
      }
    }
  }
  return results;
}

function extractMessageBody(message: WhatsAppMessage): string {
  if (message.text?.body) {
    return message.text.body;
  }
  if (message.interactive?.list_reply?.title) {
    return message.interactive.list_reply.title;
  }
  if (message.interactive?.button_reply?.title) {
    return message.interactive.button_reply.title;
  }
  if (message.interactive?.nfm_reply?.response_json) {
    return message.interactive.nfm_reply.response_json;
  }
  if (message.image?.caption) {
    return message.image.caption;
  }
  if (message.video?.caption) {
    return message.video.caption;
  }
  if (message.document?.filename) {
    return `Document: ${message.document.filename}`;
  }
  return `[${message.type ?? 'message'}]`;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

type ContactResolution = {
  contact: Prisma.Contact;
  lead: Prisma.Lead;
  createdLead: boolean;
};

async function resolveContact(phone: string): Promise<ContactResolution> {
  const existing = await prisma.contact.findFirst({
    where: { phone },
    include: { Lead: true }
  });

  if (existing && existing.Lead) {
    if (!existing.whatsappOptIn || existing.dndFlag) {
      const updated = await prisma.contact.update({
        where: { id: existing.id },
        data: { whatsappOptIn: true, dndFlag: false, preferredChannel: 'whatsapp' }
      });
      return { contact: updated, lead: existing.Lead, createdLead: false };
    }

    return { contact: existing, lead: existing.Lead, createdLead: false };
  }

  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        source: 'whatsapp',
        status: 'new',
        intentScore: 0
      }
    });

    const contact = await tx.contact.create({
      data: {
        leadId: lead.id,
        phone,
        whatsappOptIn: true,
        dndFlag: false,
        preferredChannel: 'whatsapp'
      }
    });

    return { contact, lead, createdLead: true };
  });
}

async function resolveConversation(leadId: string, occurredAt: Date) {
  const existing = await prisma.conversation.findFirst({
    where: { leadId, channel: 'whatsapp' },
    orderBy: { lastActivity: 'desc' }
  });

  if (existing) {
    return existing;
  }

  return prisma.conversation.create({
    data: {
      leadId,
      channel: 'whatsapp',
      open: true,
      lastActivity: occurredAt
    }
  });
}

async function recordJourneyUserActivity(leadId: string, occurredAt: Date): Promise<void> {
  try {
    await prisma.leadJourney.upsert({
      where: { leadId },
      update: {
        lastUserActivityAt: occurredAt,
        state: Prisma.JourneyState.PAUSE,
        nextActionAt: null,
        lastError: null
      },
      create: {
        leadId,
        state: Prisma.JourneyState.PAUSE,
        lastUserActivityAt: occurredAt
      }
    });

    await scheduleJourneyTick(leadId, { delayMs: 0 });
  } catch (error) {
    console.error('[channels-wa] Failed to record journey activity', error);
  }
}
