import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const ENV_SEARCH_FILES = ['.env.local', '.env'];

const discoveredFiles = discoverEnvFiles();
for (const filePath of discoveredFiles) {
  config({ path: filePath, override: false });
}

const preprocessOptional = (value: unknown) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  TIMEZONE: z
    .preprocess(
      (value) => {
        if (typeof value !== 'string') {
          return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      },
      z.string().default('Asia/Kolkata')
    ),
  WA_PHONE_NUMBER_ID: z.preprocess(preprocessOptional, z.string().optional()),
  WA_TOKEN: z.preprocess(preprocessOptional, z.string().optional()),
  WA_WHATSAPP_BUSINESS_ACCOUNT_ID: z.preprocess(preprocessOptional, z.string().optional()),
  WA_VERIFY_TOKEN: z.preprocess(preprocessOptional, z.string().optional()),
  WA_APP_SECRET: z.preprocess(preprocessOptional, z.string()),
  WA_TEMPLATE_INTRO: z.preprocess(preprocessOptional, z.string().optional()),
  WA_TEMPLATE_NUDGE1: z.preprocess(preprocessOptional, z.string().optional()),
  WA_TEMPLATE_NUDGE2: z.preprocess(preprocessOptional, z.string().optional()),
  WA_TEMPLATE_LANGUAGE: z.preprocess(
    preprocessOptional,
    z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, { message: 'Language code must be BCP47 (e.g. en or en-US)' })
      .default('en')
  ),
  WEBHOOK_SECRET: z.preprocess(preprocessOptional, z.string()),
  MCP_SERVER_URL: z.preprocess(preprocessOptional, z.string().url().default('http://localhost:3005')),
  OPENAI_API_KEY: z.preprocess(preprocessOptional, z.string()),
  OPENAI_MODEL: z.preprocess(preprocessOptional, z.string().default('gpt-4o-mini')),
  GCAL_CREDENTIALS_JSON_BASE64: z.preprocess(preprocessOptional, z.string().optional()),
  GCAL_CALENDAR_ID: z.preprocess(preprocessOptional, z.string()),
  S3_ENDPOINT: z.preprocess(preprocessOptional, z.string().url().optional()),
  S3_ACCESS_KEY_ID: z.preprocess(preprocessOptional, z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(preprocessOptional, z.string().optional()),
  S3_BUCKET: z.preprocess(preprocessOptional, z.string())
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const formatted = parsed.error.flatten().fieldErrors;
  const message =
    Object.keys(formatted).length > 0
      ? JSON.stringify(formatted, null, 2)
      : parsed.error.message;
  throw new Error(`Invalid environment configuration:\n${message}`);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
export { envSchema };

function discoverEnvFiles(): string[] {
  const files = new Set<string>();
  if (process.env.ENV_FILE) {
    files.add(resolve(process.env.ENV_FILE));
  }

  for (const fileName of ENV_SEARCH_FILES) {
    let current = process.cwd();
    while (true) {
      const candidate = join(current, fileName);
      if (existsSync(candidate)) {
        files.add(candidate);
        break;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return Array.from(files);
}
