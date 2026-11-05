import { Client } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface DatabasePingResult {
  ok: boolean;
  detail: string;
}

/**
 * Verifies DATABASE_URL by opening a short-lived connection and running SELECT 1.
 * Does not report success unless the query completes.
 */
export async function pingDatabase(): Promise<DatabasePingResult> {
  const connectionString = env.DATABASE_URL?.trim();

  if (!connectionString) {
    return {
      ok: false,
      detail: 'DATABASE_URL is not configured',
    };
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return {
      ok: true,
      detail: 'Database connection verified',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    logger.warn('Database readiness check failed', {
      errorMessage: message,
    });
    return {
      ok: false,
      detail: 'Database connection failed',
    };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore close errors
    }
  }
}
