import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';

loadDotenv({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  SUPABASE_URL: z.union([z.string().url(), z.literal('')]).optional().default(''),
  SUPABASE_ANON_KEY: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  DATABASE_URL: z.string().default(''),
  /** Server-only fadezy_guest_rpc pooler URL for guest booking RPCs. Never expose to clients. */
  GUEST_RPC_DATABASE_URL: z.string().default(''),
  /** Server-only fadezy_notify_worker URL for notification delivery. Never use DATABASE_URL. */
  NOTIFY_WORKER_DATABASE_URL: z.string().default(''),
  API_SERVICE_NAME: z.string().default('fadezy-api'),
  API_VERSION: z.string().default('0.1.0'),
  RESEND_API_KEY: z.string().optional().default(''),
  RESEND_FROM_EMAIL: z.string().optional().default('Fadezy OS <onboarding@resend.dev>'),
  APP_PUBLIC_URL: z.string().optional().default('http://localhost:3000'),
});

export type AppEnv = Omit<z.infer<typeof envSchema>, 'CORS_ORIGINS'> & {
  CORS_ORIGINS: string[];
};

function parseEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return parsed.data;
}

export const env = parseEnv();

export function getRequiredReadinessEnv(): Array<{ name: string; present: boolean }> {
  return [
    { name: 'DATABASE_URL', present: Boolean(env.DATABASE_URL?.trim()) },
    { name: 'NODE_ENV', present: Boolean(env.NODE_ENV) },
    { name: 'PORT', present: Number.isFinite(env.PORT) },
  ];
}
