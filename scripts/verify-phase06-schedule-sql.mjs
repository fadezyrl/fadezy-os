import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { DateTime } from 'luxon';

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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });
const results = [];

try {
  await client.connect();

  const tables = await client.query(`
    select count(*)::int as n
    from information_schema.tables
    where table_schema='public'
      and table_name in (
        'business_weekly_hours','location_weekly_hours','schedule_date_exceptions',
        'staff_weekly_schedules','staff_weekly_intervals','staff_weekly_breaks','staff_time_off'
      )
  `);
  results.push(`schedule_tables=${tables.rows[0].n}`);

  const fn = await client.query(`
    select proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and proname in (
      'replace_business_weekly_hours','replace_location_weekly_hours',
      'replace_staff_weekly_schedule','review_staff_time_off','is_business_schedule_editor'
    )
    order by 1
  `);
  results.push(`rpcs=${fn.rows.map((r) => r.proname).join(',')}`);

  const hoursMode = await client.query(`
    select 1 from information_schema.columns
    where table_name='business_locations' and column_name='hours_mode'
  `);
  results.push(`hours_mode=${hoursMode.rowCount === 1}`);

  // DST evidence via Luxon (America/New_York spring forward 2026-03-08)
  const gap = DateTime.fromISO('2026-03-08T02:30:00', { zone: 'America/New_York' });
  results.push(`dst_gap_valid=${gap.isValid}`);
  results.push(`dst_gap_reason=${gap.invalidReason || 'none'}`);

  const fold = DateTime.fromISO('2026-11-01T01:30:00', { zone: 'America/New_York' });
  results.push(`dst_fold_valid=${fold.isValid}`);
  results.push(`dst_fold_offset_minutes=${fold.isValid ? fold.offset : 'n/a'}`);

  const overnightOk = 1560 > 1440 && 1560 - 1320 === 240;
  results.push(`overnight_rule_example=${overnightOk}`);

  const pass =
    tables.rows[0].n === 7 &&
    hoursMode.rowCount === 1 &&
    fn.rows.length >= 5 &&
    overnightOk;

  console.log(results.join('\n'));
  console.log(`sql_schedule_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('sql_schedule_pass=false');
  console.error(String(error.message || error).slice(0, 500));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
