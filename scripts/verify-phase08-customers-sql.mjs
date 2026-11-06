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
const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  const idx = await client.query(`
    select indexdef
    from pg_indexes
    where schemaname = 'public' and indexname = 'bookings_customer_starts_idx'
  `);
  const def = await client.query(`
    select pg_get_functiondef('public.create_workspace_booking(uuid,uuid,uuid,uuid,uuid[],timestamptz,uuid,text,text,text,text,text,text,text)'::regprocedure) as def
  `);
  const body = def.rows[0]?.def ?? '';
  const grants = await client.query(`
    select
      has_function_privilege('anon', 'public.create_workspace_booking(uuid,uuid,uuid,uuid,uuid[],timestamptz,uuid,text,text,text,text,text,text,text)', 'execute') as anon_exec,
      has_function_privilege('authenticated', 'public.create_workspace_booking(uuid,uuid,uuid,uuid,uuid[],timestamptz,uuid,text,text,text,text,text,text,text)', 'execute') as auth_exec
  `);
  const pass =
    idx.rowCount === 1 &&
    body.toLowerCase().includes('customer_archived') &&
    body.toLowerCase().includes('security definer') &&
    grants.rows[0]?.anon_exec === false &&
    grants.rows[0]?.auth_exec === true;

  console.log('index_present=' + (idx.rowCount === 1));
  console.log('index_def=' + (idx.rows[0]?.indexdef ?? ''));
  console.log('customer_archived_guard=' + body.toLowerCase().includes('customer_archived'));
  console.log('security_definer=' + body.toLowerCase().includes('security definer'));
  console.log('anon_exec=' + grants.rows[0]?.anon_exec);
  console.log('auth_exec=' + grants.rows[0]?.auth_exec);
  console.log('sql_customers_pass=' + pass);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('sql_customers_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 500));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
