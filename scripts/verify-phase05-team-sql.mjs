/**
 * SQL-level Phase 05 checks: schema presence, last-owner protection shape, token hash column.
 */
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
const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

const results = [];

try {
  await client.connect();

  const cols = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_invitations'
      and column_name in ('token_hash', 'email', 'role', 'status', 'expires_at')
    order by 1
  `);
  results.push(`invite_cols=${cols.rows.map((r) => r.column_name).join(',')}`);
  results.push(`has_token_hash=${cols.rows.some((r) => r.column_name === 'token_hash')}`);
  results.push(`has_raw_token_col=${cols.rows.some((r) => r.column_name === 'token')}`);

  const memberCols = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_members'
      and column_name in ('deactivated_at', 'suspended_at', 'accepted_at', 'invited_at')
    order by 1
  `);
  results.push(`member_lifecycle_cols=${memberCols.rows.map((r) => r.column_name).join(',')}`);

  const profileEmail = await client.query(`
    select 1 as ok
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'staff_profiles'
      and column_name = 'email'
  `);
  results.push(`staff_profiles_email=${profileEmail.rowCount === 1}`);

  const backfill = await client.query(`
    select
      (select count(*)::int from public.business_members) as members,
      (select count(*)::int from public.staff_profiles) as profiles
  `);
  results.push(`members=${backfill.rows[0].members}`);
  results.push(`profiles=${backfill.rows[0].profiles}`);
  results.push(
    `profiles_cover_members=${Number(backfill.rows[0].profiles) >= Number(backfill.rows[0].members)}`,
  );

  const fn = await client.query(`
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_business_invitation'
    limit 1
  `);
  const def = fn.rows[0]?.def ?? '';
  results.push(`accept_uses_auth_uid=${def.includes('auth.uid()')}`);
  results.push(`accept_creates_auth_user=${/insert\s+into\s+auth\.users/i.test(def)}`);
  results.push(`accept_checks_email_match=${/EMAIL_MISMATCH/i.test(def)}`);
  results.push(`accept_checks_verified=${/EMAIL_NOT_VERIFIED/i.test(def)}`);

  const lastOwner = await client.query(`
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_business_member_status'
    limit 1
  `);
  results.push(
    `status_last_owner_protected=${/LAST_OWNER_PROTECTED/i.test(lastOwner.rows[0]?.def ?? '')}`,
  );

  const pass =
    results.includes('has_token_hash=true') &&
    results.includes('has_raw_token_col=false') &&
    results.includes('staff_profiles_email=true') &&
    results.includes('profiles_cover_members=true') &&
    results.includes('accept_uses_auth_uid=true') &&
    results.includes('accept_creates_auth_user=false') &&
    results.includes('accept_checks_email_match=true') &&
    results.includes('accept_checks_verified=true') &&
    results.includes('status_last_owner_protected=true');

  console.log(results.join('\n'));
  console.log(`sql_team_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('sql_team_pass=false');
  console.error(String(error.message || error).slice(0, 500));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
