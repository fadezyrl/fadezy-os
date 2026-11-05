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
  path.join(root, 'supabase', 'migrations', '20261105210000_business_multi_tenant.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  const tables = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'businesses',
        'business_members',
        'business_locations',
        'business_onboarding_drafts'
      )
    order by 1
  `);
  const fn = await client.query(`
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_business_with_owner'
  `);
  console.log('migration_ok=true');
  console.log(`tables=${tables.rows.map((r) => r.table_name).join(',')}`);
  console.log(`rpc_present=${fn.rowCount > 0}`);
} catch (error) {
  console.log('migration_ok=false');
  console.log(`error_code=${error.code || 'n/a'}`);
  console.log(
    `error_message=${String(error.message || '')
      .replace(/:[^:@/\s]+@/g, ':***@')
      .slice(0, 400)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
