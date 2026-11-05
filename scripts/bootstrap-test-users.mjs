/**
 * Create two confirmed auth users via SQL with identities, then sign in.
 * Avoids signup email rate limits. Does not print passwords/tokens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
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
const url = env.SUPABASE_URL?.trim();
const anon = env.SUPABASE_ANON_KEY?.trim();
const stamp = Date.now();
const password = 'VerifyPass1!';

const pg = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 15000 });
await pg.connect();

const instance = await pg.query(`
  select instance_id
  from auth.users
  where instance_id is not null
  limit 1
`);
const instanceId = instance.rows[0]?.instance_id || '00000000-0000-0000-0000-000000000000';

async function createUser(tag) {
  const id = crypto.randomUUID();
  const email = `fadezy.v3.${tag}.${stamp}@gmail.com`;

  await pg.query(
    `insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      phone_change, phone_change_token, email_change_token_current, email_change_confirm_status,
      reauthentication_token, is_sso_user, is_anonymous
    ) values (
      $1, $2, 'authenticated', 'authenticated', $3, crypt($4, gen_salt('bf')), timezone('utc', now()),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', $5::text),
      false, timezone('utc', now()), timezone('utc', now()),
      '', '', '', '',
      '', '', '', 0,
      '', false, false
    )`,
    [instanceId, id, email, password, `Verify ${tag}`],
  );

  await pg.query(
    `insert into auth.identities (
      id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), $1::text, $2::uuid,
      jsonb_build_object('sub', $1::text, 'email', $3::text, 'email_verified', true),
      'email', timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
    )`,
    [id, id, email],
  );

  return { id, email };
}

const userA = await createUser('a');
const userB = await createUser('b');
await pg.end();

const client = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const signA = await client.auth.signInWithPassword({ email: userA.email, password });
const signB = await client.auth.signInWithPassword({ email: userB.email, password });

console.log(`user_a_created=true`);
console.log(`user_b_created=true`);
console.log(`signin_a_ok=${Boolean(signA.data.session)}`);
console.log(`signin_b_ok=${Boolean(signB.data.session)}`);
if (signA.error) console.log(`signin_a_error=${signA.error.message}`);
if (signB.error) console.log(`signin_b_error=${signB.error.message}`);

if (!signA.data.session || !signB.data.session) {
  process.exitCode = 1;
} else {
  // Write tokens to a temp file ignored by git for the verification script only
  const out = {
    passwordSet: true,
    a: { email: userA.email, userId: userA.id, token: signA.data.session.access_token },
    b: { email: userB.email, userId: userB.id, token: signB.data.session.access_token },
  };
  const outPath = path.join(root, 'scripts', '.verify-tokens.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log('tokens_file_written=true');
}
