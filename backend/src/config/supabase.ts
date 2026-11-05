import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let serviceClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

function assertServerOnly(): void {
  // Defense-in-depth: this module must never be imported by frontend bundlers.
  const maybeWindow = (globalThis as { window?: unknown }).window;
  if (typeof maybeWindow !== 'undefined') {
    throw new Error('Supabase server client cannot run in a browser environment');
  }
}

/**
 * Service-role client for privileged server-side operations.
 * Never expose SUPABASE_SERVICE_ROLE_KEY to web or mobile clients.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  assertServerOnly();

  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error(
      'Supabase service client requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  if (!serviceClient) {
    serviceClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return serviceClient;
}

/**
 * Anon/publishable-key client for ordinary auth verification and RLS-scoped reads.
 * Ordinary user authentication must NOT use the service role key.
 */
export function getSupabaseAnonClient(): SupabaseClient {
  assertServerOnly();

  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    throw new Error('Supabase anon client requires SUPABASE_URL and SUPABASE_ANON_KEY');
  }

  if (!anonClient) {
    anonClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  return anonClient;
}

/**
 * Creates a short-lived client scoped to a caller's access token for RLS queries.
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  assertServerOnly();

  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    throw new Error('Supabase user client requires SUPABASE_URL and SUPABASE_ANON_KEY');
  }

  return createClient(url, key, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_ANON_KEY?.trim());
}

export function isSupabaseServiceConfigured(): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
