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
  path.join(root, 'supabase', 'migrations', '20261105290000_guest_rpc_revoke_anon.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  for (const name of ['guest_get_booking_slot_context', 'create_guest_booking']) {
    const r = await client.query(
      `
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
             has_function_privilege('fadezy_guest_rpc', p.oid, 'EXECUTE') as guest_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
    `,
      [name],
    );
    const row = r.rows[0];
    console.log(
      `fn=${row.proname};anon=${row.anon_exec};auth=${row.auth_exec};service_role=${row.service_exec};guest=${row.guest_exec};public=${row.public_exec}`,
    );
  }
  console.log('guest_rpc_revoke_applied=true');
} catch (error) {
  console.error('guest_rpc_revoke_applied=false');
  console.error(String(error.message || error).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
