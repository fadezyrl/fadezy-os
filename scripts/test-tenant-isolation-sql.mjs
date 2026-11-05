/**
 * DB-level tenant isolation test using DATABASE_URL.
 * Creates two auth users, creates businesses as each user via RPC + JWT claim simulation,
 * then verifies cross-tenant SELECT is blocked under RLS.
 * Does not print secrets.
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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });
const stamp = Date.now();

function payload(slug) {
  return {
    name: `SQL Shop ${slug}`,
    slug,
    business_type: 'barbershop',
    country_code: 'US',
    default_currency: 'USD',
    timezone: 'America/New_York',
    default_locale: 'en-US',
    client_request_id: crypto.randomUUID(),
    primary_location: {
      name: 'Main',
      location_type: 'salon',
      city: 'Austin',
      country_code: 'US',
      timezone: 'America/New_York',
    },
  };
}

async function asUser(userId, fn) {
  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`select set_config('role', 'authenticated', true)`);
    // Prefer set local role when available
    try {
      await client.query('set local role authenticated');
    } catch {
      // pooler roles may restrict SET ROLE; continue with claim-based auth.uid()
    }
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

try {
  await client.connect();

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  await client.query(
    `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values
      ($1, 'authenticated', 'authenticated', $2, crypt('TempPass1!', gen_salt('bf')), timezone('utc', now()), '{}'::jsonb, '{}'::jsonb, timezone('utc', now()), timezone('utc', now())),
      ($3, 'authenticated', 'authenticated', $4, crypt('TempPass1!', gen_salt('bf')), timezone('utc', now()), '{}'::jsonb, '{}'::jsonb, timezone('utc', now()), timezone('utc', now()))`,
    [userA, `sql.a.${stamp}@fadezy.local`, userB, `sql.b.${stamp}@fadezy.local`],
  );

  const createdA = await asUser(userA, async () => {
    const { rows } = await client.query(`select public.create_business_with_owner($1::jsonb) as result`, [
      JSON.stringify(payload(`sql-a-${stamp}`)),
    ]);
    return rows[0].result;
  });

  const createdB = await asUser(userB, async () => {
    const { rows } = await client.query(`select public.create_business_with_owner($1::jsonb) as result`, [
      JSON.stringify(payload(`sql-b-${stamp}`)),
    ]);
    return rows[0].result;
  });

  const businessA = createdA.business.id;
  const businessB = createdB.business.id;

  const aSeesB = await asUser(userA, async () => {
    const { rows } = await client.query(
      `select id from public.businesses where id = $1`,
      [businessB],
    );
    return rows.length;
  });

  const bSeesA = await asUser(userB, async () => {
    const { rows } = await client.query(
      `select id from public.businesses where id = $1`,
      [businessA],
    );
    return rows.length;
  });

  const aSeesOwn = await asUser(userA, async () => {
    const { rows } = await client.query(
      `select id from public.businesses where id = $1`,
      [businessA],
    );
    return rows.length;
  });

  const escalation = await asUser(userA, async () => {
    try {
      await client.query(
        `insert into public.business_members (business_id, user_id, role, membership_status)
         values ($1, $2, 'owner', 'active')`,
        [businessB, userA],
      );
      return 'allowed';
    } catch (error) {
      return `blocked:${error.code || 'err'}`;
    }
  });

  const ownerA = createdA.membership.user_id;
  const ownerB = createdB.membership.user_id;

  const pass =
    ownerA === userA &&
    ownerB === userB &&
    aSeesOwn === 1 &&
    aSeesB === 0 &&
    bSeesA === 0 &&
    String(escalation).startsWith('blocked');

  console.log(`owner_a_matches=${ownerA === userA}`);
  console.log(`owner_b_matches=${ownerB === userB}`);
  console.log(`a_sees_own=${aSeesOwn}`);
  console.log(`a_sees_b=${aSeesB}`);
  console.log(`b_sees_a=${bSeesA}`);
  console.log(`role_escalation=${escalation}`);
  console.log(`sql_tenant_isolation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(`sql_tenant_isolation_pass=false`);
  console.log(
    `error=${String(error.message || error)
      .replace(/:[^:@/\s]+@/g, ':***@')
      .slice(0, 350)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
