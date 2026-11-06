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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });
await client.connect();

const { rows } = await client.query(`
  select p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         coalesce(p.proacl::text, '<default>') as acl,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
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
for (const row of rows) {
  console.log(
    `${row.proname}|anon=${row.anon_exec}|auth=${row.auth_exec}|public=${row.public_exec}|acl=${row.acl}`,
  );
}
await client.end();
