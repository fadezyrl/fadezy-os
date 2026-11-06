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
  path.join(root, 'supabase', 'migrations', '20261105260000_booking_privilege_rpcs.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  const fns = await client.query(`
    select p.proname, pg_get_userbyid(p.proowner) as owner,
           p.prosecdef as security_definer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_workspace_booking',
        'reschedule_booking_times',
        'create_guest_booking',
        'guest_get_booking_slot_context',
        'assert_can_manage_booking_location'
      )
    order by 1
  `);
  console.log('booking_privilege_migration_applied=true');
  for (const row of fns.rows) {
    console.log(`fn=${row.proname};owner=${row.owner};security_definer=${row.security_definer}`);
  }
  const grants = await client.query(`
    select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join pg_roles r
    where n.nspname='public'
      and p.proname in ('create_workspace_booking','create_guest_booking','guest_get_booking_slot_context','reschedule_booking_times')
      and r.rolname in ('anon','authenticated','public')
    order by 1,2
  `);
  for (const row of grants.rows) {
    console.log(`grant=${row.proname};role=${row.rolname};execute=${row.can_execute}`);
  }
} catch (error) {
  console.error('booking_privilege_migration_applied=false');
  console.error(String(error.message || error).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
