import type { HealthStatusData, ReadinessCheck, ReadinessStatusData } from '@fadezy/shared';
import { env, getRequiredReadinessEnv } from '../../config/env';
import { isSupabaseConfigured } from '../../config/supabase';
import { pingDatabase } from '../../services/database';

export function getHealthStatus(): HealthStatusData {
  return {
    status: 'ok',
    service: env.API_SERVICE_NAME,
    version: env.API_VERSION,
    timestamp: new Date().toISOString(),
  };
}

export async function getReadinessStatus(): Promise<ReadinessStatusData> {
  const checks: ReadinessCheck[] = getRequiredReadinessEnv().map((item) => ({
    name: `env:${item.name}`,
    ok: item.present,
    detail: item.present ? 'present' : 'missing',
  }));

  const dbPing = await pingDatabase();
  checks.push({
    name: 'database',
    ok: dbPing.ok,
    detail: dbPing.detail,
  });

  checks.push({
    name: 'supabase_api_config',
    ok: isSupabaseConfigured(),
    detail: isSupabaseConfigured()
      ? 'SUPABASE_URL and SUPABASE_ANON_KEY present'
      : 'SUPABASE_URL / SUPABASE_ANON_KEY not configured (optional for Phase 01 readiness)',
  });

  // Ready when required env vars exist and database connectivity is verified.
  // Supabase JS keys are tracked but not required for readiness in Phase 01
  // because the existing project already uses DATABASE_URL for Postgres access.
  const requiredOk = checks
    .filter((check) => check.name.startsWith('env:') || check.name === 'database')
    .every((check) => check.ok);

  return {
    status: requiredOk ? 'ready' : 'not_ready',
    service: env.API_SERVICE_NAME,
    version: env.API_VERSION,
    timestamp: new Date().toISOString(),
    checks,
  };
}
