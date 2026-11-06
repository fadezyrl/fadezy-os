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
  path.join(root, 'supabase', 'migrations', '20261105270000_booking_grant_hygiene.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);

  const fns = [
    'list_staff_busy_ranges',
    'transition_booking_status',
    'create_guest_booking',
    'guest_get_booking_slot_context',
    'create_workspace_booking',
  ];
  for (const name of fns) {
    const { rows } = await client.query(
      `
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
    `,
      [name],
    );
    for (const row of rows) {
      console.log(
        `fn=${row.proname};anon=${row.anon_exec};auth=${row.auth_exec};public=${row.public_exec};service_role=${row.service_exec}`,
      );
    }
  }

  const tables = [
    'bookings',
    'booking_services',
    'booking_addons',
    'booking_status_events',
    'customers',
  ];
  for (const table of tables) {
    for (const role of ['anon', 'authenticated']) {
      const privs = [];
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await client.query(
          `select has_table_privilege($1, $2, $3) as ok`,
          [role, `public.${table}`, priv],
        );
        if (r.rows[0].ok) privs.push(priv);
      }
      console.log(`table=${table};role=${role};privs=${privs.join(',') || 'none'}`);
    }
  }

  console.log('booking_grant_hygiene_applied=true');
} catch (error) {
  console.error('booking_grant_hygiene_applied=false');
  console.error(String(error.message || error).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
