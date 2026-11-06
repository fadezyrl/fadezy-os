import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';

let pool: Pool | null = null;

/**
 * Dedicated pool for guest booking SECURITY DEFINER RPCs.
 * Uses fadezy_guest_rpc credentials — never the bypass-RLS DATABASE_URL pool.
 */
export function getGuestRpcPool(): Pool {
  if (!pool) {
    const connectionString = env.GUEST_RPC_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error(
        'GUEST_RPC_DATABASE_URL is required for guest booking RPC access',
      );
    }
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

export async function guestRpcQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const client = await getGuestRpcPool().connect();
  try {
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}

export async function withGuestRpcClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getGuestRpcPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
