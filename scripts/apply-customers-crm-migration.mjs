import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

const root = path.resolve(import.meta.dirname, '..');
const env = loadEnv(path.join(root, 'backend', '.env'));
const sql = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261106100000_customers_crm.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  const idx = await client.query(`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'bookings_customer_starts_idx'
  `);
  const src = await client.query(`
    select pg_get_functiondef('public.create_workspace_booking(uuid,uuid,uuid,uuid,uuid[],timestamptz,uuid,text,text,text,text,text,text,text)'::regprocedure) as def
  `);
  const def = src.rows[0]?.def ?? '';
  console.log('customers_crm_migration_applied=true');
  console.log('bookings_customer_starts_idx=' + (idx.rowCount === 1));
  console.log('customer_archived_guard=' + def.toLowerCase().includes('customer_archived'));
} catch (error) {
  console.error('customers_crm_migration_applied=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
