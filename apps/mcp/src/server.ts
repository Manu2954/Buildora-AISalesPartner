import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  prisma,
  Prisma,
  guardQuietHours,
  rateLimit,
  sendTemplateWA,
  replyWA,
  offerSlots,
  bookSlot,
  generateQuotePdf
} from '@buildora/shared';

type JsonSchema = {
  input: unknown;
  output: unknown;
};

type ToolContext = {
  actor: string;
  toolName: string;
};

type ToolHandler = (input: unknown, context: ToolContext) => Promise<unknown>;

type ToolDefinition = {
  name: string;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
  handler: ToolHandler;
  schema: JsonSchema;
};

type LeadLookupInput = {
  leadId?: string;
  contactId?: string;
};

type LeadLookupOutput = {
  leadId: string;
  status: string;
  intentScore: number;
  city: string | null;
  locality: string | null;
  propertyType: string | null;
  openConversationCount: number;
  latestConversationId: string | null;
  latestQuoteStatus: string | null;
  projectStage: string | null;
  contacts: Array<{
    contactId: string;
    role: string | null;
    hasWhatsappOptIn: boolean;
    dndFlag: boolean;
  }>;
};

type ConsentCheckInput = {
  contactId: string;
  channel: string;
};

type ConsentRecordInput = {
  contactId: string;
  channel: string;
  status: 'granted' | 'revoked' | 'unknown';
  proof?: Record<string, unknown> | null;
};

type MessageTemplateInput = {
  contactId?: string;
  leadId?: string;
  phone: string;
  templateName: string;
  languageCode: string;
  variables?: string[];
};

type MessageReplyInput = {
  contactId?: string;
  leadId?: string;
  phone: string;
  text: string;
  mediaUrl?: string;
};

type CalendarOfferSlotsInput = {
  leadId: string;
  durationMin: number;
};

type CalendarBookSlotInput = {
  leadId: string;
  slotIso: string;
  location?: string;
  durationMin?: number;
};

type QuoteGenerateInput = {
  leadId: string;
  packageKey: string;
  amountLow: number;
  amountHigh: number;
};

class ToolError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaDir = dirname(fileURLToPath(new URL('./schemas', import.meta.url)));
const toolsCache: { promise: Promise<Map<string, ToolDefinition>> | null } = { promise: null };

const SENSITIVE_KEYS = new Set(['phone', 'text', 'variables', 'mediaUrl', 'proof']);

export async function startMcpServer(port: number): Promise<Server> {
  const tools = await getToolRegistry();
  const server = createServer((req, res) => {
    void handleRequest(req, res, tools);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, resolve);
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tools: Map<string, ToolDefinition>
): Promise<void> {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Missing URL' } });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/schemas') {
      sendJson(res, 200, { tools: Array.from(tools.keys()) });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/schemas/')) {
      const toolName = decodeURIComponent(url.pathname.replace('/schemas/', ''));
      const tool = tools.get(toolName);
      if (!tool) {
        sendJson(res, 404, { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${toolName}` } });
        return;
      }
      sendJson(res, 200, tool.schema);
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/tools/')) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
      return;
    }

    const toolName = decodeURIComponent(url.pathname.replace('/tools/', ''));
    const tool = tools.get(toolName);
    if (!tool) {
      sendJson(res, 404, { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${toolName}` } });
      return;
    }

    const body = await readRequestBody(req);
    let parsedBody: unknown = undefined;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } });
        return;
      }
    }

    const { input, actor } = normalizeToolRequest(parsedBody);
    const actorId = actor ?? (typeof req.headers['x-actor'] === 'string' ? req.headers['x-actor'] : 'llm');

    if (!tool.validateInput(input)) {
      sendJson(res, 400, {
        error: {
          code: 'INVALID_INPUT',
          message: formatValidationErrors(tool.validateInput.errors)
        }
      });
      return;
    }

    let result: unknown;
    try {
      result = await tool.handler(input, { actor: actorId, toolName });
    } catch (error) {
      const normalized = normalizeError(error);
      await recordAudit(toolName, actorId, input, { error: normalized.audit });
      sendJson(res, normalized.status, { error: { code: normalized.code, message: normalized.message } });
      return;
    }

    if (!tool.validateOutput(result)) {
      await recordAudit(toolName, actorId, input, {
        error: { code: 'INVALID_OUTPUT', details: tool.validateOutput.errors }
      });
      sendJson(res, 500, {
        error: { code: 'INVALID_OUTPUT', message: 'Tool produced invalid output' }
      });
      return;
    }

    await recordAudit(toolName, actorId, input, result);
    sendJson(res, 200, { result });
  } catch (error) {
    console.error('[mcp] Unhandled error', error);
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  }
}

async function getToolRegistry(): Promise<Map<string, ToolDefinition>> {
  if (!toolsCache.promise) {
    toolsCache.promise = buildToolRegistry();
  }
  return toolsCache.promise;
}

async function buildToolRegistry(): Promise<Map<string, ToolDefinition>> {
  const registry = new Map<string, ToolDefinition>();

  const register = async (name: string, handler: ToolHandler) => {
    const schema = await loadSchema(name);
    registry.set(name, {
      name,
      handler,
      schema,
      validateInput: ajv.compile(schema.input),
      validateOutput: ajv.compile(schema.output)
    });
  };

  await register('lead.lookup', async (input) => leadLookupHandler(input as LeadLookupInput));
  await register('consent.check', async (input) => consentCheckHandler(input as ConsentCheckInput));
  await register('consent.record', async (input) => consentRecordHandler(input as ConsentRecordInput));
  await register('message.send.whatsapp_template', async (input, ctx) =>
    messageSendTemplateHandler(input as MessageTemplateInput, ctx)
  );
  await register('message.reply', async (input, ctx) =>
    messageReplyHandler(input as MessageReplyInput, ctx)
  );
  await register('calendar.offer_slots', async (input) =>
    calendarOfferSlotsHandler(input as CalendarOfferSlotsInput)
  );
  await register('calendar.book_slot', async (input) =>
    calendarBookSlotHandler(input as CalendarBookSlotInput)
  );
  await register('quote.generate_pdf', async (input) => quoteGenerateHandler(input as QuoteGenerateInput));

  return registry;
}

async function leadLookupHandler(input: LeadLookupInput): Promise<LeadLookupOutput> {
  const { leadId: directLeadId, contactId } = input;
  let resolvedLeadId = directLeadId ?? null;

  if (!resolvedLeadId && contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { leadId: true }
    });
    if (!contact) {
      throw new ToolError('NOT_FOUND', 'Contact not found', 404);
    }
    resolvedLeadId = contact.leadId;
  }

  if (!resolvedLeadId) {
    throw new ToolError('INVALID_INPUT', 'A leadId or contactId is required', 400);
  }

  const lead = await prisma.lead.findUnique({
    where: { id: resolvedLeadId },
    select: {
      id: true,
      status: true,
      intentScore: true,
      city: true,
      locality: true,
      propertyType: true,
      contacts: {
        select: { id: true, role: true, whatsappOptIn: true, dndFlag: true }
      },
      conversations: {
        select: { id: true, open: true },
        orderBy: { lastActivity: 'desc' },
        take: 5
      },
      quotes: {
        select: { status: true },
        orderBy: { createdAt: 'desc' },
        take: 1
      },
      project: {
        select: { stage: true }
      }
    }
  });

  if (!lead) {
    throw new ToolError('NOT_FOUND', 'Lead not found', 404);
  }

  const openConversationCount = lead.conversations.filter((conversation) => conversation.open).length;
  const latestConversationId = lead.conversations[0]?.id ?? null;
  const latestQuoteStatus = lead.quotes[0]?.status ?? null;

  const contacts = lead.contacts.map((contact) => ({
    contactId: contact.id,
    role: contact.role,
    hasWhatsappOptIn: contact.whatsappOptIn,
    dndFlag: contact.dndFlag
  }));

  return {
    leadId: lead.id,
    status: lead.status,
    intentScore: lead.intentScore,
    city: lead.city ?? null,
    locality: lead.locality ?? null,
    propertyType: lead.propertyType ?? null,
    openConversationCount,
    latestConversationId,
    latestQuoteStatus,
    projectStage: lead.project?.stage ?? null,
    contacts
  };
}

async function consentCheckHandler(input: ConsentCheckInput) {
  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: { id: true, whatsappOptIn: true, dndFlag: true }
  });

  if (!contact) {
    throw new ToolError('NOT_FOUND', 'Contact not found', 404);
  }

  const latestConsent = await prisma.consent.findFirst({
    where: { contactId: input.contactId, channel: input.channel },
    orderBy: { recordedAt: 'desc' }
  });

  const status =
    latestConsent?.status ??
    (input.channel === 'whatsapp' && contact.whatsappOptIn ? 'granted' : 'unknown');

  const recordedAt = latestConsent?.recordedAt?.toISOString() ?? null;

  if (contact.dndFlag && status === 'granted') {
    return { status: 'revoked', recordedAt };
  }

  return {
    status,
    recordedAt
  };
}

async function consentRecordHandler(input: ConsentRecordInput) {
  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: { id: true }
  });

  if (!contact) {
    throw new ToolError('NOT_FOUND', 'Contact not found', 404);
  }

  const record = await prisma.consent.create({
    data: {
      contactId: input.contactId,
      channel: input.channel,
      status: input.status,
      proof: input.proof ?? undefined
    }
  });

  const updateData: Prisma.ContactUpdateInput = {};
  if (input.channel === 'whatsapp') {
    if (input.status === 'granted') {
      updateData.whatsappOptIn = true;
      updateData.dndFlag = false;
    } else if (input.status === 'revoked') {
      updateData.whatsappOptIn = false;
      updateData.dndFlag = true;
    }
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.contact.update({
      where: { id: input.contactId },
      data: updateData
    });
  }

  return {
    consentId: record.id,
    status: record.status,
    recordedAt: record.recordedAt.toISOString()
  };
}

async function messageSendTemplateHandler(input: MessageTemplateInput, _ctx: ToolContext) {
  const rateKey = generateRateLimitKey(input.contactId, input.leadId);
  enforceQuietHours();

  const contact = input.contactId
    ? await prisma.contact.findUnique({
        where: { id: input.contactId },
        select: {
          id: true,
          leadId: true,
          whatsappOptIn: true,
          dndFlag: true
        }
      })
    : null;

  if (input.contactId && !contact) {
    throw new ToolError('NOT_FOUND', 'Contact not found', 404);
  }

  const leadId = input.leadId ?? contact?.leadId;
  if (!leadId) {
    throw new ToolError('INVALID_INPUT', 'leadId is required when contact is not linked', 400);
  }

  if (contact) {
    await assertWhatsappConsent(contact.id, {
      whatsappOptIn: contact.whatsappOptIn,
      dndFlag: contact.dndFlag
    });
  }

  enforceRateLimit(rateKey);

  const result = await sendTemplateWA({
    phone: input.phone,
    templateName: input.templateName,
    languageCode: input.languageCode,
    variables: input.variables ?? []
  });

  return result;
}

async function messageReplyHandler(input: MessageReplyInput, _ctx: ToolContext) {
  const rateKey = generateRateLimitKey(input.contactId, input.leadId);
  enforceQuietHours();

  const contact = input.contactId
    ? await prisma.contact.findUnique({
        where: { id: input.contactId },
        select: {
          id: true,
          leadId: true,
          whatsappOptIn: true,
          dndFlag: true
        }
      })
    : null;

  if (input.contactId && !contact) {
    throw new ToolError('NOT_FOUND', 'Contact not found', 404);
  }

  if (contact) {
    await assertWhatsappConsent(contact.id, {
      whatsappOptIn: contact.whatsappOptIn,
      dndFlag: contact.dndFlag
    });
  }

  enforceRateLimit(rateKey);

  const result = await replyWA({
    phone: input.phone,
    text: input.text,
    mediaUrl: input.mediaUrl
  });

  return result;
}

async function calendarOfferSlotsHandler(input: CalendarOfferSlotsInput) {
  const slots = await offerSlots({
    leadId: input.leadId,
    durationMin: input.durationMin
  });

  return { slots };
}

async function calendarBookSlotHandler(input: CalendarBookSlotInput) {
  const result = await bookSlot({
    leadId: input.leadId,
    slotIso: input.slotIso,
    location: input.location,
    durationMin: input.durationMin
  });

  return {
    eventId: result.eventId,
    summary: result.summary,
    start: result.start,
    end: result.end,
    htmlLink: result.htmlLink ?? null,
    hangoutLink: result.hangoutLink ?? null
  };
}

async function quoteGenerateHandler(input: QuoteGenerateInput) {
  const result = await generateQuotePdf({
    leadId: input.leadId,
    packageKey: input.packageKey,
    amountLow: input.amountLow,
    amountHigh: input.amountHigh
  });

  return result;
}

function enforceQuietHours(): void {
  if (!guardQuietHours(new Date())) {
    throw new ToolError(
      'QUIET_HOURS',
      'WhatsApp messaging is limited to 10:00-19:00 Asia/Kolkata.',
      429
    );
  }
}

function enforceRateLimit(rateKey: string): void {
  const result = rateLimit(rateKey);
  if (!result.allowed) {
    throw new ToolError('RATE_LIMITED', result.reason ?? 'Rate limit exceeded', 429);
  }
}

type ContactConsentSnapshot = {
  whatsappOptIn: boolean;
  dndFlag: boolean;
};

async function assertWhatsappConsent(
  contactId: string,
  snapshot?: ContactConsentSnapshot
): Promise<void> {
  const contact =
    snapshot ??
    (await prisma.contact.findUnique({
      where: { id: contactId },
      select: { whatsappOptIn: true, dndFlag: true }
    }));

  if (!contact) {
    throw new ToolError('NOT_FOUND', 'Contact not found', 404);
  }

  if (contact.dndFlag) {
    throw new ToolError('CONSENT_REQUIRED', 'Contact is flagged as Do Not Disturb', 403);
  }

  if (contact.whatsappOptIn) {
    return;
  }

  const latestConsent = await prisma.consent.findFirst({
    where: { contactId, channel: 'whatsapp' },
    orderBy: { recordedAt: 'desc' }
  });

  if (!latestConsent || latestConsent.status !== 'granted') {
    throw new ToolError('CONSENT_REQUIRED', 'Missing WhatsApp consent for contact', 403);
  }
}

function generateRateLimitKey(contactId?: string, leadId?: string): string {
  if (contactId) {
    return `contact:${contactId}`;
  }
  if (leadId) {
    return `lead:${leadId}`;
  }
  throw new ToolError('INVALID_INPUT', 'Either contactId or leadId must be provided', 400);
}

async function loadSchema(name: string): Promise<JsonSchema> {
  const filePath = join(schemaDir, `${name}.json`);
  const raw = await readFile(filePath, 'utf8');
  const schema = JSON.parse(raw) as JsonSchema;
  if (!schema.input || !schema.output) {
    throw new Error(`Schema ${name} must contain input and output definitions`);
  }
  return schema;
}

function normalizeToolRequest(body: unknown): { input: unknown; actor?: string } {
  if (!body || typeof body !== 'object') {
    return { input: {} };
  }
  const value = body as Record<string, unknown>;
  if (value.input && typeof value.input === 'object') {
    return { input: value.input, actor: typeof value.actor === 'string' ? value.actor : undefined };
  }
  return { input: value };
}

async function recordAudit(
  tool: string,
  actor: string,
  args: unknown,
  result: unknown
): Promise<void> {
  try {
    await prisma.mcpAudit.create({
      data: {
        tool,
        actor,
        args: sanitizeForAudit(args) as Prisma.JsonValue,
        result: sanitizeForAudit(result) as Prisma.JsonValue
      }
    });
  } catch (error) {
    console.error('[mcp] Failed to persist audit log', error);
  }
}

function sanitizeForAudit(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAudit(item));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, val]) => {
      if (SENSITIVE_KEYS.has(key)) {
        return [key, '[redacted]'];
      }
      return [key, sanitizeForAudit(val)];
    });
    return Object.fromEntries(entries);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 256 ? `${value.slice(0, 253)}...` : value;
  }
  return '[unserializable]';
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'Invalid input';
  }
  return errors
    .map((error) => {
      const instancePath = error.instancePath ? error.instancePath : 'input';
      return `${instancePath} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  audit: Record<string, unknown>;
} {
  if (error instanceof ToolError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      audit: { code: error.code, message: error.message }
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error',
      audit: { message: error.message, name: error.name }
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Unexpected error',
    audit: { message: 'Unknown error' }
  };
}
