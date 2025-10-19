import {
  env,
  createLogger,
  messagesOutboundTotal,
  replyLatencySeconds,
  errorRate,
  bookRate,
  type Logger
} from '@buildora/shared';

import { buildDeveloperPrompt } from './developerPrompt.js';
import { createModel, ChatMessage, ToolDefinition } from './modelProvider.js';
import { McpClient } from './mcpClient.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import type { ConversationContext } from './transcript.js';
import { loadConversationContext } from './transcript.js';

type TurnOptions = {
  leadId?: string;
  contactId?: string;
  triggerMessageId?: string;
};

const TOOL_ORDER = [
  'lead.lookup',
  'consent.check',
  'consent.record',
  'message.send.whatsapp_template',
  'message.reply',
  'calendar.offer_slots',
  'calendar.book_slot',
  'quote.generate_pdf'
] as const;

const TOOL_DESCRIPTIONS = new Map<string, string>([
  ['lead.lookup', 'Retrieve current lead summary and contact preferences'],
  ['consent.check', 'Check consent status for a given contact and channel'],
  ['consent.record', 'Record new consent proof and update opt-in flags'],
  ['message.send.whatsapp_template', 'Send a pre-approved WhatsApp template'],
  ['message.reply', 'Reply to the user on WhatsApp with free-form text'],
  ['calendar.offer_slots', 'Retrieve available appointment slots for the lead'],
  ['calendar.book_slot', 'Book an appointment slot for the lead'],
  ['quote.generate_pdf', 'Generate and upload a branded quote PDF for the lead']
]);

const model = createModel();
const mcpClient = new McpClient(env.MCP_SERVER_URL, 'assistant');
let toolSpecsPromise: Promise<ToolDefinition[]> | null = null;

export async function handleTurn(
  conversationId: string,
  options: TurnOptions = {}
): Promise<void> {
  const context = await loadConversationContext(conversationId, { limit: 15 });
  const log = createLogger({ component: 'assistant', conversationId, leadId: context.lead.id });

  if (options.leadId && options.leadId !== context.lead.id) {
    log.warn(
      { expectedLeadId: options.leadId, actualLeadId: context.lead.id },
      'lead mismatch for conversation'
    );
  }

  if (options.contactId && context.contact && options.contactId !== context.contact.id) {
    log.warn(
      { expectedContactId: options.contactId, actualContactId: context.contact.id },
      'contact mismatch for conversation'
    );
  }

  const sanitizedLead = await fetchSanitizedLead(context.lead.id);
  const developerPrompt = buildDeveloperPrompt({
    lead: context.lead,
    sanitizedLead,
    contact: context.contact ?? undefined,
    conversation: {
      channel: context.channel,
      latestUserMessage: context.latestUserMessage ?? undefined,
      openConversationCount: context.openConversationCount ?? undefined
    }
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: developerPrompt }
  ];

  for (const transcriptMessage of context.messages) {
    messages.push({
      role: transcriptMessage.role,
      content: transcriptMessage.content
    });
  }

  const tools = await ensureToolSpecs();
  const maxIterations = 6;

  for (let index = 0; index < maxIterations; index += 1) {
    const response = await model.generate({ messages, tools });
    const assistantMessage = response.message;

    messages.push({
      role: 'assistant',
      content: assistantMessage.content,
      toolCalls: assistantMessage.toolCalls
    });

    const toolCalls = assistantMessage.toolCalls ?? [];
    if (toolCalls.length === 0) {
      const finalText = (assistantMessage.content ?? '').trim();
      if (!finalText) {
        log.warn('model completed without final reply');
        return;
      }

      await sendFinalReply(context, finalText, log);
      return;
    }

    for (const toolCall of toolCalls) {
      const toolResult = await executeTool(toolCall.name, toolCall.arguments, log);

      if (!isToolError(toolResult) && toolCall.name === 'calendar.book_slot') {
        bookRate.inc({ channel: context.channel });
      }

      log.info(
        {
          tool: toolCall.name,
          arguments: toolCall.arguments,
          result: toolResult,
          conversationId,
          leadId: context.lead.id
        },
        'tool executed'
      );

      messages.push({
        role: 'tool',
        name: toolCall.name,
        toolCallId: toolCall.id,
        content: JSON.stringify(toolResult)
      });
    }
  }

  log.warn('max iterations reached without final reply');
}

async function ensureToolSpecs(): Promise<ToolDefinition[]> {
  if (!toolSpecsPromise) {
    toolSpecsPromise = (async () => {
      const availableTools = await mcpClient.listTools();
      const desiredTools = TOOL_ORDER.filter((tool) => availableTools.includes(tool));
      return mcpClient.getToolSpecs(desiredTools, TOOL_DESCRIPTIONS);
    })();
  }
  return toolSpecsPromise;
}

async function fetchSanitizedLead(leadId: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await mcpClient.callTool<{ leadId: string }, Record<string, unknown>>('lead.lookup', {
      leadId
    });
    return result;
  } catch (error) {
    createLogger({ component: 'assistant', leadId }).warn(error, 'failed to fetch sanitized lead');
    return null;
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  log: Logger = createLogger({ component: 'assistant', tool: name })
): Promise<unknown> {
  try {
    return await mcpClient.callTool(name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorRate.inc({ component: `tool:${name}` });
    log.error({ error: message, tool: name }, 'tool execution failed');
    return { error: message };
  }
}

async function sendFinalReply(
  context: ConversationContext,
  text: string,
  log: Logger = createLogger({ component: 'assistant' })
): Promise<void> {
  if (!context.contact || !context.contact.phone) {
    throw new Error('Cannot send reply: contact phone missing');
  }

  await mcpClient.callTool('message.reply', {
    contactId: context.contact.id,
    leadId: context.lead.id,
    phone: context.contact.phone,
    text
  });

  messagesOutboundTotal.inc({ channel: context.channel, type: 'final_reply' });
  if (context.latestUserMessageAt) {
    const latencySeconds = (Date.now() - context.latestUserMessageAt.getTime()) / 1000;
    replyLatencySeconds.observe({ channel: context.channel }, latencySeconds);
  }

  log.info(
    {
      leadId: context.lead.id,
      conversationId: context.conversationId,
      textLength: text.length
    },
    'sent final reply'
  );
}

function isToolError(result: unknown): result is { error: unknown } {
  return !!result && typeof result === 'object' && 'error' in (result as Record<string, unknown>);
}
