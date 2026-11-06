import { Pool, type QueryResultRow } from 'pg';
import { env } from '../config/env';

let pool: Pool | null = null;

/**
 * Dedicated pool for notification delivery worker RPCs.
 * Uses fadezy_notify_worker credentials — never the bypass-RLS DATABASE_URL pool.
 */
export function getNotifyWorkerPool(): Pool {
  if (!pool) {
    const connectionString = env.NOTIFY_WORKER_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error(
        'NOTIFY_WORKER_DATABASE_URL is required for the notification delivery worker',
      );
    }
    pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

export async function notifyWorkerQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const client = await getNotifyWorkerPool().connect();
  try {
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}
