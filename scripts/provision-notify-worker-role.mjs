/**
 * Provisions LOGIN + password for fadezy_notify_worker and writes
 * NOTIFY_WORKER_DATABASE_URL into backend/.env. Password is never printed.
 *
 * Usage: node scripts/provision-notify-worker-role.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

function upsertEnvVar(filePath, key, value) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  fs.writeFileSync(filePath, next.join('\n'), 'utf8');
}

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, 'backend', '.env');
const env = loadEnv(envPath);
if (!env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const adminUrl = new URL(env.DATABASE_URL.replace(/^postgresql:/, 'postgres:'));
const adminUser = decodeURIComponent(adminUrl.username);
const projectRef = adminUser.includes('.') ? adminUser.split('.').slice(1).join('.') : null;
const workerUser = projectRef ? `fadezy_notify_worker.${projectRef}` : 'fadezy_notify_worker';
const password = crypto.randomBytes(32).toString('base64url');

const client = new Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  const exists = await client.query(
    `select 1 from pg_roles where rolname = 'fadezy_notify_worker'`,
  );
  if (!exists.rowCount) {
    throw new Error('Role fadezy_notify_worker missing — apply notifications worker migration first');
  }

  const quoted = await client.query(`select quote_literal($1) as q`, [password]);
  await client.query(
    `alter role fadezy_notify_worker with login password ${quoted.rows[0].q}`,
  );

  const attrs = await client.query(`
    select rolcanlogin, rolsuper, rolbypassrls, rolinherit
    from pg_roles where rolname = 'fadezy_notify_worker'
  `);
  console.log(`role_login=${attrs.rows[0].rolcanlogin}`);
  console.log(`role_super=${attrs.rows[0].rolsuper}`);
  console.log(`role_bypass_rls=${attrs.rows[0].rolbypassrls}`);
  console.log(`role_inherit=${attrs.rows[0].rolinherit}`);

  const workerUrl = new URL(env.DATABASE_URL.replace(/^postgresql:/, 'postgres:'));
  workerUrl.username = workerUser;
  workerUrl.password = password;
  const connectionString = workerUrl.toString().replace(/^postgres:/, 'postgresql:');

  upsertEnvVar(envPath, 'NOTIFY_WORKER_DATABASE_URL', connectionString);
  console.log('notify_worker_env_written=true');
  console.log(`notify_worker_pooler_user=${workerUser}`);
  console.log('notify_worker_password_rotated=true');
} catch (error) {
  console.error('notify_worker_provision_failed=true');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

try {
  const workerEnv = loadEnv(envPath);
  const smoke = new Client({
    connectionString: workerEnv.NOTIFY_WORKER_DATABASE_URL,
    connectionTimeoutMillis: 20000,
  });
  await smoke.connect();
  const who = await smoke.query(`select current_user, session_user`);
  console.log(`notify_login_ok=true;current_user=${who.rows[0].current_user}`);
  const table = await smoke.query(
    `select has_table_privilege(current_user, 'public.notification_deliveries', 'SELECT') as can_select`,
  );
  console.log(`notify_deliveries_select=${table.rows[0].can_select}`);
  const claim = await smoke.query(
    `select has_function_privilege(current_user, 'public.claim_notification_deliveries(integer, text)', 'EXECUTE') as can_claim`,
  );
  console.log(`notify_claim_execute=${claim.rows[0].can_claim}`);
  await smoke.end();
} catch (error) {
  console.error('notify_login_ok=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
}
