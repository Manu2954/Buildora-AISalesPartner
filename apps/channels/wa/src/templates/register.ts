#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import { env } from '@buildora/shared';

const GRAPH_API_VERSION = 'v17.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

type Command = 'list' | 'push' | 'help';

type TemplatePayload = {
  name: string;
  category: string;
  allow_category_change?: boolean;
  language: string;
  components: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

async function main() {
  const command = parseCommand(process.argv.slice(2));

  if (command === 'help') {
    printHelp();
    process.exit(0);
  }

  assertEnv('WA_WHATSAPP_BUSINESS_ACCOUNT_ID');
  assertEnv('WA_TOKEN');

  switch (command) {
    case 'list':
      await listTemplates();
      break;
    case 'push':
      await pushTemplates(process.argv.slice(3));
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

function parseCommand(argv: string[]): Command {
  const [first] = argv;
  if (!first) return 'help';
  if (first === 'list') return 'list';
  if (first === 'push') return 'push';
  if (first === '--help' || first === 'help') return 'help';
  return 'help';
}

function printHelp() {
  console.log(`Usage:
  pnpm --filter @buildora/channel-wa tsx src/templates/register.ts list
  pnpm --filter @buildora/channel-wa tsx src/templates/register.ts push templates/buildora_intro_v2.json [...more]

Environment:
  WA_WHATSAPP_BUSINESS_ACCOUNT_ID   WhatsApp Business Account ID (WABA)
  WA_TOKEN                          System user access token with template permissions
`);
}

function assertEnv(key: keyof typeof env) {
  if (!env[key]) {
    console.error(`Missing required environment variable ${key}`);
    process.exit(1);
  }
}

async function listTemplates(): Promise<void> {
  const url = new URL(`${BASE_URL}/${env.WA_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`);
  url.searchParams.set('limit', '50');

  const response = await fetch(url, {
    headers: authHeaders()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Failed to fetch templates:', JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  const templates = payload?.data ?? [];
  if (templates.length === 0) {
    console.log('No templates found.');
    return;
  }

  for (const template of templates) {
    console.log(
      [
        template.name,
        `category=${template.category}`,
        `status=${template.status}`,
        `id=${template.id}`
      ].join(' | ')
    );
  }
}

async function pushTemplates(files: string[]): Promise<void> {
  if (!files || files.length === 0) {
    console.error('Please provide one or more template JSON files to register.');
    process.exit(1);
  }

  for (const file of files) {
    const absolute = join(process.cwd(), file);
    const contents = await readFile(absolute, 'utf8');
    const payload = JSON.parse(contents) as TemplatePayload;

    validateTemplatePayload(payload, file);

    const body = new URLSearchParams();
    body.set('name', payload.name);
    body.set('language', payload.language);
    body.set('category', payload.category);
    if (payload.allow_category_change !== undefined) {
      body.set('allow_category_change', String(payload.allow_category_change));
    }
    body.set('components', JSON.stringify(payload.components ?? []));

    const response = await fetch(
      `${BASE_URL}/${env.WA_WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      }
    );

    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(
        `✔ Registered template ${payload.name} (${basename(file)}) status=${result.status ?? 'submitted'} id=${result.id ?? 'pending'}`
      );
    } else if (
      result?.error?.error_subcode === 2018001 ||
      /(already exists|already has a template)/i.test(result?.error?.message ?? '')
    ) {
      console.warn(`ℹ Template ${payload.name} already exists. Review status via list command.`);
    } else {
      console.error(`✖ Failed to register ${payload.name}:`, JSON.stringify(result, null, 2));
    }
  }
}

function validateTemplatePayload(payload: TemplatePayload, file: string) {
  const requiredFields: Array<keyof TemplatePayload> = ['name', 'category', 'language', 'components'];
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null) {
      console.error(`Template ${file} missing required field ${field}`);
      process.exit(1);
    }
  }
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.WA_TOKEN}`
  };
}

await main().catch((error) => {
  console.error('[register] Unexpected error', error);
  process.exit(1);
});
