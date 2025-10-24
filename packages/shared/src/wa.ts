import { env } from './env.js';
import { AppError } from './errors.js';

import { z } from 'zod';

const twilioMessageResponseSchema = z
  .object({
    sid: z.string(),
    status: z.string().optional(),
    messaging_service_sid: z.string().optional(),
    error_code: z.union([z.string(), z.number()]).nullable().optional(),
    error_message: z.string().nullable().optional()
  })
  .passthrough();

const twilioErrorResponseSchema = z
  .object({
    status: z.number().optional(),
    code: z.number().optional(),
    message: z.string(),
    more_info: z.string().optional(),
    details: z.unknown().optional()
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

type TemplateConfig = {
  contentSid?: string;
  body?: string;
  mediaUrl?: string;
  from?: string;
  messagingServiceSid?: string;
};

type TemplateMap = Record<string, TemplateConfig>;

let cachedTemplateMap: TemplateMap | null = null;

const ensureTwilioConfig = (overrides?: TemplateConfig) => {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new AppError(
      'WA_CONFIG_MISSING',
      'Twilio configuration missing: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required'
    );
  }

  const resolvedFrom = overrides?.from ?? env.TWILIO_WHATSAPP_FROM;
  const resolvedMessagingServiceSid = overrides?.messagingServiceSid ?? env.TWILIO_MESSAGING_SERVICE_SID;

  if (!resolvedFrom && !resolvedMessagingServiceSid) {
    throw new AppError(
      'WA_CONFIG_MISSING',
      'Twilio configuration missing: supply either TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID'
    );
  }
};

const loadTemplateMap = (): TemplateMap => {
  if (cachedTemplateMap) {
    return cachedTemplateMap;
  }

  if (!env.TWILIO_TEMPLATE_MAP) {
    cachedTemplateMap = {};
    return cachedTemplateMap;
  }

  try {
    const parsed = JSON.parse(env.TWILIO_TEMPLATE_MAP) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Parsed value is not an object');
    }
    cachedTemplateMap = parsed as TemplateMap;
    return cachedTemplateMap;
  } catch (error) {
    throw new AppError('WA_TEMPLATE_CONFIG_INVALID', 'Invalid TWILIO_TEMPLATE_MAP JSON', {
      details: error instanceof Error ? error.message : String(error)
    });
  }
};

const resolveTemplateConfig = (templateName: string, languageCode: string): TemplateConfig | undefined => {
  const map = loadTemplateMap();
  const withLanguageKey = `${templateName}:${languageCode}`;
  return map[withLanguageKey] ?? map[templateName];
};

const fallbackTemplateConfig = (templateName: string): TemplateConfig | undefined => {
  if (/^HX[0-9A-F]{32}$/i.test(templateName)) {
    return { contentSid: templateName };
  }
  return undefined;
};

const formatWhatsAppAddress = (phone: string): string => {
  const trimmed = phone.trim();
  if (trimmed.startsWith('whatsapp:')) {
    return trimmed;
  }
  if (trimmed.startsWith('+')) {
    return `whatsapp:${trimmed}`;
  }
  return `whatsapp:+${trimmed}`;
};

const createBaseParams = (phone: string, overrides?: TemplateConfig): URLSearchParams => {
  const params = new URLSearchParams();
  params.append('To', formatWhatsAppAddress(phone));

  const resolvedFrom = overrides?.from ?? env.TWILIO_WHATSAPP_FROM;
  const resolvedMessagingServiceSid = overrides?.messagingServiceSid ?? env.TWILIO_MESSAGING_SERVICE_SID;

  if (resolvedMessagingServiceSid) {
    params.append('MessagingServiceSid', resolvedMessagingServiceSid);
  } else if (resolvedFrom) {
    params.append('From', formatWhatsAppAddress(resolvedFrom));
  }

  return params;
};

const buildContentVariables = (variables: string[]): string | undefined => {
  if (!variables.length) {
    return undefined;
  }

  const map: Record<string, string> = {};
  variables.forEach((value, index) => {
    map[(index + 1).toString()] = value;
  });
  return JSON.stringify(map);
};

const applyTemplateBody = (body: string, variables: string[]): string => {
  let result = body;
  variables.forEach((value, index) => {
    const placeholder = new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g');
    result = result.replace(placeholder, value);
  });
  return result;
};

const getAuthHeader = (): string => {
  const credentials = `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`;
  const encoded = Buffer.from(credentials, 'utf8').toString('base64');
  return `Basic ${encoded}`;
};

const twilioApiUrl = (): string =>
  `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;

export async function sendTemplateWA({
  phone,
  templateName,
  languageCode,
  variables = []
}: WaSendTemplateInput): Promise<WaSendResult> {
  const templateConfig = resolveTemplateConfig(templateName, languageCode) ?? fallbackTemplateConfig(templateName);
  ensureTwilioConfig(templateConfig);

  const params = createBaseParams(phone, templateConfig);

  if (templateConfig?.contentSid) {
    params.append('ContentSid', templateConfig.contentSid);
    const contentVariables = buildContentVariables(variables);
    if (contentVariables) {
      params.append('ContentVariables', contentVariables);
    }
  } else if (templateConfig?.body) {
    params.append('Body', applyTemplateBody(templateConfig.body, variables));
    if (templateConfig.mediaUrl) {
      params.append('MediaUrl', templateConfig.mediaUrl);
    }
  } else {
    throw new AppError('WA_TEMPLATE_NOT_CONFIGURED', `Template ${templateName} is not configured for Twilio`, {
      details: { templateName, languageCode }
    });
  }

  return callTwilio(params);
}

export async function replyWA({ phone, text, mediaUrl }: WaReplyInput): Promise<WaSendResult> {
  ensureTwilioConfig();

  const params = createBaseParams(phone);
  params.append('Body', text);
  if (mediaUrl) {
    params.append('MediaUrl', mediaUrl);
  }

  return callTwilio(params);
}

async function callTwilio(params: URLSearchParams): Promise<WaSendResult> {
  const res = await fetch(twilioApiUrl(), {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const rawPayload = await res.text();
  let payload: unknown = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch (error) {
      throw new AppError('WA_PARSE_ERROR', 'Failed to parse Twilio response as JSON', {
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!res.ok) {
    const parsedError = twilioErrorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      throw new AppError('WA_API_ERROR', parsedError.data.message, {
        status: parsedError.data.status ?? res.status,
        details: {
          code: parsedError.data.code,
          moreInfo: parsedError.data.more_info,
          raw: parsedError.data.details
        }
      });
    }
    throw new AppError('WA_API_ERROR', `Twilio API error (status ${res.status})`, {
      status: res.status,
      details: payload
    });
  }

  const parsedResponse = twilioMessageResponseSchema.safeParse(payload);
  if (!parsedResponse.success) {
    throw new AppError('WA_SCHEMA_MISMATCH', `Unexpected Twilio response: ${parsedResponse.error.message}`);
  }

  const message = parsedResponse.data;

  return {
    conversationId: null,
    messageId: message.sid,
    status: message.status ?? null
  };
}
