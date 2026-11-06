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
  path.join(root, 'supabase', 'migrations', '20261105240000_working_hours.sql'),
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
        'business_weekly_hours',
        'location_weekly_hours',
        'schedule_date_exceptions',
        'staff_weekly_schedules',
        'staff_weekly_intervals',
        'staff_weekly_breaks',
        'staff_time_off'
      )
    order by 1
  `);
  const col = await client.query(`
    select 1 as ok
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_locations'
      and column_name = 'hours_mode'
  `);
  console.log('schedule_migration_applied=true');
  console.log('tables=' + tables.rows.map((r) => r.table_name).join(','));
  console.log('hours_mode_col=' + (col.rowCount === 1));
} catch (error) {
  console.error('schedule_migration_applied=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
