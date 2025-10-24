import type { LeadJourney } from '@prisma/client';

import {
  Prisma,
  env,
  prisma,
  createLogger,
  messagesOutboundTotal,
  errorRate,
  AppError,
  evaluateConsent
} from '@buildora/shared';

import { McpClient } from './mcpClient.js';
import type { JourneyJob } from './queues.js';

const HOURS = (value: number) => value * 60 * 60 * 1000;
const MINUTES = (value: number) => value * 60 * 1000;

const CONSENT_RETRY_DELAY_MS = HOURS(24);
const CONSENT_RECHECK_DELAY_MS = HOURS(4);
const INTRO_TO_NUDGE_DELAY_MS = HOURS(12);
const FIRST_NUDGE_DELAY_MS = HOURS(24);
const SECOND_NUDGE_DELAY_MS = HOURS(72);
const QUIET_RETRY_DELAY_MS = MINUTES(60);
const GENERIC_RETRY_DELAY_MS = HOURS(3);

const mcpClient = new McpClient(env.MCP_SERVER_URL, 'journey-orchestrator');

type ProcessOptions = Omit<JourneyJob, 'leadId'> & {
  now?: Date;
};

type JourneyProcessResult = {
  nextActionAt: Date | null;
  state: Prisma.JourneyState;
};

type LeadWithContacts = Prisma.LeadGetPayload<{
  include: {
    contacts: {
      select: {
        id: true;
        name: true;
        phone: true;
        role: true;
        preferredChannel: true;
        whatsappOptIn: true;
        dndFlag: true;
      };
    };
  };
}>;

type ContactSummary = {
  id: string;
  name: string | null;
  phone: string | null;
  whatsappOptIn: boolean;
  dndFlag: boolean;
};

type TemplateAttempt =
  | { status: 'sent' }
  | { status: 'consent_required' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; message: string; retryDelayMs: number };

export async function processJourney(
  leadId: string,
  options: ProcessOptions = {}
): Promise<JourneyProcessResult> {
  const now = options.now ?? new Date();

  const [journeyRecord, lead] = await Promise.all([
    prisma.leadJourney.findUnique({ where: { leadId } }),
    prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        contacts: {
          select: {
            id: true,
            name: true,
            phone: true,
            role: true,
            preferredChannel: true,
            whatsappOptIn: true,
            dndFlag: true
          }
        }
      }
    })
  ]);

  if (!lead) {
    throw new AppError('LEAD_NOT_FOUND', `Lead ${leadId} not found`, { status: 404 });
  }

  const journey =
    journeyRecord ??
    (await prisma.leadJourney.create({
      data: {
        leadId,
        state: Prisma.JourneyState.NEW
      }
    }));

  const contact = selectPrimaryContact(lead);

  let state = journey.state;
  let nextActionAt: Date | null = journey.nextActionAt ?? null;
  let lastActionAt: Date | null = journey.lastActionAt ?? null;
  let lastError: string | null = journey.lastError ?? null;
  let attemptsIncrement = 0;
  let manualSuppressedUntil = journey.manualSuppressedUntil ?? null;

  if (manualSuppressedUntil && manualSuppressedUntil > now) {
    state = Prisma.JourneyState.PAUSE;
    nextActionAt = manualSuppressedUntil;
    lastError = 'Manual suppression active';
    return finalizeJourney(journey.id, {
      state,
      nextActionAt,
      lastActionAt,
      lastError,
      attemptsIncrement,
      manualSuppressedUntil
    });
  }

  if (manualSuppressedUntil && manualSuppressedUntil <= now) {
    manualSuppressedUntil = null;
    if (state === Prisma.JourneyState.PAUSE) {
      state = Prisma.JourneyState.CONSENT_CHECK;
      nextActionAt = now;
      lastError = null;
    }
  }

  if (options.force && state === Prisma.JourneyState.PAUSE) {
    state = Prisma.JourneyState.CONSENT_CHECK;
    nextActionAt = now;
  }

  switch (state) {
    case Prisma.JourneyState.NEW: {
      state = Prisma.JourneyState.CONSENT_CHECK;
      nextActionAt = now;
      lastError = null;
      break;
    }

    case Prisma.JourneyState.CONSENT_CHECK: {
      if (!contact || !contact.phone) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = 'No WhatsApp contact available for journey';
        break;
      }

      const consentStatus = await getConsentStatus(contact.id);
      if (consentStatus === 'granted') {
        state = Prisma.JourneyState.READY;
        nextActionAt = now;
        lastError = null;
      } else {
        state = Prisma.JourneyState.CONSENT_CHECK;
        nextActionAt = new Date(now.getTime() + CONSENT_RETRY_DELAY_MS);
        lastError = `Consent status: ${consentStatus}`;
      }
      break;
    }

    case Prisma.JourneyState.READY: {
      if (!contact || !contact.phone) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = 'No WhatsApp contact available for intro template';
        break;
      }
      if (!env.WA_TEMPLATE_INTRO) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = 'Intro template not configured';
        break;
      }

      const outcome = await attemptTemplateSend({
        templateName: env.WA_TEMPLATE_INTRO,
        lead,
        contact,
        allowConsentFallback: true
      });

      if (outcome.status === 'sent') {
        state = Prisma.JourneyState.INTRO_SENT;
        lastActionAt = now;
        lastError = null;
        nextActionAt = new Date(now.getTime() + INTRO_TO_NUDGE_DELAY_MS);
        attemptsIncrement += 1;
      } else if (outcome.status === 'consent_required') {
        state = Prisma.JourneyState.CONSENT_CHECK;
        lastError = 'Consent required before sending intro';
        nextActionAt = new Date(now.getTime() + CONSENT_RECHECK_DELAY_MS);
      } else if (outcome.status === 'error') {
        lastError = outcome.message;
        nextActionAt = new Date(now.getTime() + outcome.retryDelayMs);
      } else {
        // skipped
        state = Prisma.JourneyState.PAUSE;
        lastError = outcome.reason;
        nextActionAt = null;
      }
      break;
    }

    case Prisma.JourneyState.INTRO_SENT: {
      if (isUserActive(journey)) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = null;
        break;
      }
      if (!contact || !contact.phone) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = 'Missing contact for first nudge';
        break;
      }
      if (!env.WA_TEMPLATE_NUDGE1) {
        state = Prisma.JourneyState.PAUSE;
        lastError = 'First nudge template not configured';
        nextActionAt = null;
        break;
      }

      const outcome = await attemptTemplateSend({
        templateName: env.WA_TEMPLATE_NUDGE1,
        lead,
        contact,
        allowConsentFallback: true
      });

      if (outcome.status === 'sent') {
        state = Prisma.JourneyState.NUDGE_1;
        lastActionAt = now;
        lastError = null;
        nextActionAt = new Date(now.getTime() + FIRST_NUDGE_DELAY_MS);
        attemptsIncrement += 1;
      } else if (outcome.status === 'consent_required') {
        state = Prisma.JourneyState.CONSENT_CHECK;
        nextActionAt = new Date(now.getTime() + CONSENT_RECHECK_DELAY_MS);
        lastError = 'Consent required before nudge 1';
      } else if (outcome.status === 'error') {
        lastError = outcome.message;
        nextActionAt = new Date(now.getTime() + outcome.retryDelayMs);
      } else {
        state = Prisma.JourneyState.PAUSE;
        lastError = outcome.reason;
        nextActionAt = null;
      }
      break;
    }

    case Prisma.JourneyState.NUDGE_1: {
      if (isUserActive(journey)) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = null;
        break;
      }
      if (!contact || !contact.phone) {
        state = Prisma.JourneyState.PAUSE;
        nextActionAt = null;
        lastError = 'Missing contact for second nudge';
        break;
      }
      if (!env.WA_TEMPLATE_NUDGE2) {
        state = Prisma.JourneyState.PAUSE;
        lastError = 'Second nudge template not configured';
        nextActionAt = null;
        break;
      }

      const outcome = await attemptTemplateSend({
        templateName: env.WA_TEMPLATE_NUDGE2,
        lead,
        contact,
        allowConsentFallback: true
      });

      if (outcome.status === 'sent') {
        state = Prisma.JourneyState.NUDGE_2;
        lastActionAt = now;
        lastError = null;
        nextActionAt = new Date(now.getTime() + SECOND_NUDGE_DELAY_MS);
        attemptsIncrement += 1;
      } else if (outcome.status === 'consent_required') {
        state = Prisma.JourneyState.CONSENT_CHECK;
        nextActionAt = new Date(now.getTime() + CONSENT_RECHECK_DELAY_MS);
        lastError = 'Consent required before nudge 2';
      } else if (outcome.status === 'error') {
        lastError = outcome.message;
        nextActionAt = new Date(now.getTime() + outcome.retryDelayMs);
      } else {
        state = Prisma.JourneyState.PAUSE;
        lastError = outcome.reason;
        nextActionAt = null;
      }
      break;
    }

    case Prisma.JourneyState.NUDGE_2: {
      if (isUserActive(journey)) {
        state = Prisma.JourneyState.PAUSE;
        lastError = null;
        nextActionAt = null;
        break;
      }
      state = Prisma.JourneyState.PAUSE;
      nextActionAt = null;
      lastError = null;
      break;
    }

    case Prisma.JourneyState.PAUSE:
    case Prisma.JourneyState.BOOKING:
    case Prisma.JourneyState.QUALIFIED:
    case Prisma.JourneyState.QUOTE_SENT:
    case Prisma.JourneyState.WON:
    case Prisma.JourneyState.LOST:
    case Prisma.JourneyState.HUMAN_HANDOFF: {
      nextActionAt = null;
      break;
    }

    default: {
      nextActionAt = null;
      break;
    }
  }

  return finalizeJourney(journey.id, {
    state,
    nextActionAt,
    lastActionAt,
    lastError,
    attemptsIncrement,
    manualSuppressedUntil
  });
}

async function finalizeJourney(
  journeyId: string,
  params: {
    state: Prisma.JourneyState;
    nextActionAt: Date | null;
    lastActionAt: Date | null;
    lastError: string | null;
    manualSuppressedUntil: Date | null;
    attemptsIncrement: number;
  }
) {
  const updated = await prisma.leadJourney.update({
    where: { id: journeyId },
    data: {
      state: params.state,
      nextActionAt: params.nextActionAt,
      lastActionAt: params.lastActionAt,
      lastError: params.lastError,
      manualSuppressedUntil: params.manualSuppressedUntil,
      attempts: params.attemptsIncrement ? { increment: params.attemptsIncrement } : undefined
    }
  });

  return {
    state: updated.state,
    nextActionAt: updated.nextActionAt ?? null
  };
}

function selectPrimaryContact(lead: LeadWithContacts): ContactSummary | null {
  if (!lead.contacts || lead.contacts.length === 0) {
    return null;
  }

  const score = (contact: (typeof lead.contacts)[number]) => {
    let value = 0;
    if (contact.preferredChannel === 'whatsapp') value += 5;
    if (contact.whatsappOptIn) value += 4;
    if (contact.phone) value += 3;
    if (!contact.dndFlag) value += 1;
    return value;
  };

  const sorted = [...lead.contacts].sort((a, b) => score(b) - score(a));
  const primary = sorted[0];

  return {
    id: primary.id,
    name: primary.name ?? null,
    phone: primary.phone ?? null,
    whatsappOptIn: primary.whatsappOptIn,
    dndFlag: primary.dndFlag
  };
}

function isUserActive(journey: LeadJourney): boolean {
  if (!journey.lastUserActivityAt) {
    return false;
  }
  if (!journey.lastActionAt) {
    return journey.lastUserActivityAt != null;
  }
  return journey.lastUserActivityAt.getTime() > journey.lastActionAt.getTime();
}

async function getConsentStatus(contactId: string): Promise<string> {
  try {
    const result = await mcpClient.callTool<{ contactId: string; channel: string }, { status: string }>(
      'consent.check',
      {
        contactId,
        channel: 'whatsapp'
      }
    );
    return result.status ?? 'unknown';
  } catch (error) {
    console.error('[assistant] consent.check failed', error);
    return 'unknown';
  }
}

async function attemptTemplateSend({
  templateName,
  lead,
  contact,
  allowConsentFallback
}: {
  templateName: string;
  lead: LeadWithContacts;
  contact: ContactSummary;
  allowConsentFallback: boolean;
}): Promise<TemplateAttempt> {
  if (!contact.phone) {
    return { status: 'skipped', reason: 'Contact phone missing' };
  }

  const consentStatus = await getConsentStatus(contact.id);
  const consentDecision = evaluateConsent({
    whatsappOptIn: contact.whatsappOptIn,
    dndFlag: contact.dndFlag,
    status: consentStatus
  });

  if (!consentDecision.allowed) {
    return allowConsentFallback
      ? { status: 'consent_required' }
      : { status: 'skipped', reason: consentDecision.reason ?? `Consent status ${consentStatus}` };
  }

  try {
    await mcpClient.callTool('message.send.whatsapp_template', {
      contactId: contact.id,
      leadId: lead.id,
      phone: contact.phone,
      templateName,
      languageCode: env.WA_TEMPLATE_LANGUAGE ?? 'en',
      variables: buildTemplateVariables(lead, contact)
    });
    messagesOutboundTotal.inc({ channel: 'whatsapp', type: templateName });
    createLogger({ component: 'journey', leadId: lead.id }).info(
      { templateName, contactId: contact.id },
      'sent proactive template'
    );
    return { status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorRate.inc({ component: 'journey:template' });
    const retryDelayMs = message.toLowerCase().includes('quiet hours') ? QUIET_RETRY_DELAY_MS : GENERIC_RETRY_DELAY_MS;
    return { status: 'error', message, retryDelayMs };
  }
}

function buildTemplateVariables(_lead: LeadWithContacts, contact: ContactSummary): string[] {
  const name = contact.name ?? '';
  return name ? [name] : [];
}
