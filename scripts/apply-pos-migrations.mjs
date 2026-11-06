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
const files = [
  '20261107100000_pos_foundation.sql',
  '20261107110000_pos_privilege_rpcs.sql',
  '20261107120000_pos_mutation_rpcs.sql',
  '20261107130000_pos_helper_grant_hygiene.sql',
  '20261107140000_pos_update_open_sale_idempotency.sql',
];

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', file), 'utf8');
    await client.query(sql);
    console.log(`${file}=ok`);
  }
  const tables = await client.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_name in
      ('sales','sale_lines','sale_payments','sale_refunds','register_sessions','register_cash_movements')
    order by 1
  `);
  console.log('pos_tables=' + tables.rows.map((r) => r.table_name).join(','));
  console.log('pos_migrations_applied=true');
} catch (error) {
  console.error('pos_migrations_applied=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
