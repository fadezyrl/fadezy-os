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
  path.join(root, 'supabase', 'migrations', '20261105230000_staff_team.sql'),
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
        'business_invitations',
        'staff_profiles',
        'staff_location_assignments',
        'staff_service_assignments'
      )
    order by 1
  `);
  const rpcs = await client.query(`
    select routine_name
    from information_schema.routines
    where routine_schema = 'public'
      and routine_name in (
        'create_business_invitation',
        'accept_business_invitation',
        'cancel_business_invitation',
        'update_business_member_role',
        'update_business_member_status',
        'set_staff_locations',
        'set_staff_services',
        'is_business_team_manager',
        'count_active_owners'
      )
    order by 1
  `);
  console.log('team_migration_applied=true');
  console.log('tables=' + tables.rows.map((r) => r.table_name).join(','));
  console.log('rpcs=' + rpcs.rows.map((r) => r.routine_name).join(','));
} catch (error) {
  console.error('team_migration_applied=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
