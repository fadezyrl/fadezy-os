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
  path.join(root, 'supabase', 'migrations', '20261105280000_guest_rpc_role.sql'),
  'utf8',
);

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);

  const role = await client.query(`
    select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb,
           rolreplication, rolinherit
    from pg_roles where rolname = 'fadezy_guest_rpc'
  `);
  console.log(`role=${JSON.stringify(role.rows[0] ?? null)}`);

  const members = await client.query(`
    select r.rolname as member_of
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    join pg_roles u on u.oid = m.member
    where u.rolname = 'fadezy_guest_rpc'
  `);
  console.log(`memberships=${members.rows.map((r) => r.member_of).join(',') || 'none'}`);

  for (const fn of ['guest_get_booking_slot_context', 'create_guest_booking', 'create_workspace_booking']) {
    const r = await client.query(
      `
      select has_function_privilege('fadezy_guest_rpc', p.oid, 'EXECUTE') as can_exec,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
    `,
      [fn],
    );
    console.log(
      `fn=${fn};guest_exec=${r.rows[0]?.can_exec};anon_exec=${r.rows[0]?.anon_exec}`,
    );
  }

  for (const table of ['bookings', 'customers']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const r = await client.query(
        `select has_table_privilege('fadezy_guest_rpc', $1, $2) as ok`,
        [`public.${table}`, priv],
      );
      if (r.rows[0].ok) console.log(`UNEXPECTED table priv ${table} ${priv}`);
    }
  }
  console.log('guest_rpc_role_migration_applied=true');
} catch (error) {
  console.error('guest_rpc_role_migration_applied=false');
  console.error(String(error.message || error).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
