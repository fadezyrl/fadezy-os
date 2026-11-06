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
  path.join(root, 'supabase', 'migrations', '20261105250000_bookings.sql'),
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
        'customers',
        'bookings',
        'booking_services',
        'booking_addons',
        'booking_status_events'
      )
    order by 1
  `);
  const excl = await client.query(`
    select 1
    from pg_constraint
    where conname = 'bookings_staff_busy_excl'
  `);
  console.log('bookings_migration_applied=true');
  console.log('tables=' + tables.rows.map((r) => r.table_name).join(','));
  console.log('exclusion=' + (excl.rowCount === 1));
} catch (error) {
  console.error('bookings_migration_applied=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
