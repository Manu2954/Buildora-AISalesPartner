import { env } from './env.js';

import { z } from 'zod';

const WA_API_VERSION = 'v17.0';

const waResponseSchema = z
  .object({
    messaging_product: z.string().optional(),
    messages: z
      .array(
        z
          .object({
            id: z.string(),
            message_status: z.string().optional(),
            conversation: z.object({ id: z.string().optional() }).partial().optional()
          })
          .passthrough()
      )
      .optional(),
    error: z
      .object({
        message: z.string(),
        type: z.string().optional(),
        code: z.number().optional(),
        error_subcode: z.number().optional(),
        fbtrace_id: z.string().optional()
      })
      .optional(),
    meta: z
      .object({
        conversation_id: z.string().optional(),
        message_id: z.string().optional()
      })
      .optional()
  })
  .passthrough();

type WaSendTemplateInput = {
  phone: string;
  templateName: string;
  languageCode: string;
  variables?: string[];
};

type WaReplyInput = {
  phone: string;
  text: string;
  mediaUrl?: string;
};

type WaSendResult = {
  conversationId: string | null;
  messageId: string;
  status: string | null;
};

const ensureWaConfig = () => {
  if (!env.WA_TOKEN || !env.WA_PHONE_NUMBER_ID) {
    throw new Error('WhatsApp configuration missing: WA_TOKEN and WA_PHONE_NUMBER_ID are required');
  }
};

export async function sendTemplateWA({
  phone,
  templateName,
  languageCode,
  variables = []
}: WaSendTemplateInput): Promise<WaSendResult> {
  ensureWaConfig();

  const components =
    variables.length === 0
      ? undefined
      : [
          {
            type: 'body',
            parameters: variables.map((value) => ({ type: 'text', text: value }))
          }
        ];

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  };

  const response = await callWhatsApp(payload);
  return response;
}

export async function replyWA({ phone, text, mediaUrl }: WaReplyInput): Promise<WaSendResult> {
  ensureWaConfig();

  const payload = mediaUrl
    ? {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: {
          link: mediaUrl,
          caption: text
        }
      }
    : {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: {
          preview_url: false,
          body: text
        }
      };

  const response = await callWhatsApp(payload);
  return response;
}

async function callWhatsApp(body: Record<string, unknown>): Promise<WaSendResult> {
  const url = `https://graph.facebook.com/${WA_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const payload = await res.json().catch(() => {
    throw new Error('Failed to parse WhatsApp response as JSON');
  });

  const parsed = waResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Unexpected WhatsApp response: ${parsed.error.message}`);
  }
  if (!res.ok || parsed.data.error) {
    const errorMessage =
      parsed.data.error?.message ?? `WhatsApp API error (status ${res.status})`;
    throw new Error(errorMessage);
  }

  const message = parsed.data.messages?.[0];
  if (!message) {
    throw new Error('WhatsApp API response missing message details');
  }

  const conversationId =
    parsed.data.meta?.conversation_id ??
    message.conversation?.id ??
    null;

  return {
    conversationId,
    messageId: message.id,
    status: message.message_status ?? null
  };
}
