import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env';

let pool: Pool | null = null;

export function getPgPool(): Pool {
  if (!pool) {
    if (!env.DATABASE_URL?.trim()) {
      throw new Error('DATABASE_URL is required for emergency/admin Postgres access');
    }
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
