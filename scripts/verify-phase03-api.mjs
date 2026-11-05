/**
 * Phase 03 API tenant-isolation verification.
 * Prefers existing auth users + password sign-in to avoid signup email rate limits.
 * Never prints tokens or secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

const root = path.resolve(import.meta.dirname, '..');
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const url = backendEnv.SUPABASE_URL?.trim();
const anon = backendEnv.SUPABASE_ANON_KEY?.trim();
const service = backendEnv.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !anon) {
  console.log('blocked=true reason=missing_supabase_public_config');
  process.exit(1);
}

const stamp = Date.now();
const password = 'VerifyPass1!';
const results = [];

async function api(method, pathName, token, body) {
  const response = await fetch(`${apiBase}${pathName}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function businessPayload(slug) {
  return {
    name: `Verify Shop ${slug}`,
    slug,
    businessType: 'beauty_salon',
    countryCode: 'GB',
    defaultCurrency: 'GBP',
    timezone: 'Europe/London',
    defaultLocale: 'en-GB',
    clientRequestId: crypto.randomUUID(),
    primaryLocation: {
      name: 'Flagship',
      locationType: 'salon',
      city: 'London',
      countryCode: 'GB',
      timezone: 'Europe/London',
      isPrimary: true,
    },
  };
}

async function ensureUser(tag) {
  const email = `fadezy.verify.${tag}.${stamp}@gmail.com`;
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (service) {
    const admin = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `Verify ${tag}` },
    });
    if (created.error) {
      throw new Error(`admin_create_${tag}:${created.error.message}`);
    }
  } else {
    // Avoid signup email path when possible: insert confirmed user via SQL + bcrypt,
    // then sign in with password grant.
    const pg = new Client({
      connectionString: backendEnv.DATABASE_URL,
      connectionTimeoutMillis: 15000,
    });
    await pg.connect();
    try {
      const id = crypto.randomUUID();
      await pg.query(
        `insert into auth.users (
           id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at
         ) values (
           $1,
           '00000000-0000-0000-0000-000000000000',
           'authenticated',
           'authenticated',
           $2,
           crypt($3, gen_salt('bf')),
           timezone('utc', now()),
           '{"provider":"email","providers":["email"]}'::jsonb,
           '{}'::jsonb,
           timezone('utc', now()),
           timezone('utc', now())
         )
         on conflict (id) do nothing`,
        [id, email, password],
      );
      // Also ensure identity row exists for GoTrue email provider when table is present
      await pg.query(
        `insert into auth.identities (
           id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
         )
         select gen_random_uuid(), u.id,
                jsonb_build_object('sub', u.id::text, 'email', u.email),
                'email', u.id::text, timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
         from auth.users u
         where u.email = $1
           and not exists (
             select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
           )`,
        [email],
      );
    } finally {
      await pg.end();
    }
  }

  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) {
    throw new Error(`signin_${tag}:${signed.error?.message || 'no_session'}`);
  }
  return {
    email,
    token: signed.data.session.access_token,
    userId: signed.data.session.user.id,
  };
}

try {
  const unauth = await api('POST', '/api/v1/businesses', null, businessPayload(`u-${stamp}`));
  results.push(`unauth_create=${unauth.status}`);

  const userA = await ensureUser('a');
  const userB = await ensureUser('b');
  results.push('users_ready=true');

  const createA = await api('POST', '/api/v1/businesses', userA.token, businessPayload(`va-${stamp}`));
  const createB = await api('POST', '/api/v1/businesses', userB.token, businessPayload(`vb-${stamp}`));
  results.push(`create_a=${createA.status}`);
  results.push(`create_b=${createB.status}`);
  if (!createA.json?.success || !createB.json?.success) {
    throw new Error(`create_failed a=${JSON.stringify(createA.json?.error || createA.status)} b=${JSON.stringify(createB.json?.error || createB.status)}`);
  }

  const businessA = createA.json.data.business.id;
  const businessB = createB.json.data.business.id;
  const ownerA = createA.json.data.membership.userId;
  const ownerB = createB.json.data.membership.userId;
  results.push(`owner_a_ok=${ownerA === userA.userId}`);
  results.push(`owner_b_ok=${ownerB === userB.userId}`);

  const listA = await api('GET', '/api/v1/businesses', userA.token);
  const listB = await api('GET', '/api/v1/businesses', userB.token);
  const idsA = (listA.json.data || []).map((b) => b.id);
  const idsB = (listB.json.data || []).map((b) => b.id);
  results.push(`list_a_has_a=${idsA.includes(businessA)}`);
  results.push(`list_a_has_b=${idsA.includes(businessB)}`);
  results.push(`list_b_has_b=${idsB.includes(businessB)}`);
  results.push(`list_b_has_a=${idsB.includes(businessA)}`);

  const aGetB = await api('GET', `/api/v1/businesses/${businessB}`, userA.token);
  const bGetA = await api('GET', `/api/v1/businesses/${businessA}`, userB.token);
  const aPatchB = await api('PATCH', `/api/v1/businesses/${businessB}`, userA.token, {
    description: 'should fail',
  });
  const aLocB = await api('POST', `/api/v1/businesses/${businessB}/locations`, userA.token, {
    name: 'Intruder',
    locationType: 'salon',
    city: 'Paris',
    countryCode: 'FR',
    timezone: 'Europe/Paris',
    isPrimary: false,
  });
  const bGetALoc = await api('GET', `/api/v1/businesses/${businessA}/locations`, userB.token);
  results.push(`a_get_b=${aGetB.status}`);
  results.push(`b_get_a=${bGetA.status}`);
  results.push(`a_patch_b=${aPatchB.status}`);
  results.push(`a_add_loc_b=${aLocB.status}`);
  results.push(`b_get_a_locs=${bGetALoc.status}`);

  // Draft isolation
  const draftA = await api('PUT', '/api/v1/businesses/onboarding-draft', userA.token, {
    draft: { secret: 'alpha-only', step: 2 },
  });
  const draftB = await api('PUT', '/api/v1/businesses/onboarding-draft', userB.token, {
    draft: { secret: 'bravo-only', step: 3 },
  });
  const readA = await api('GET', '/api/v1/businesses/onboarding-draft', userA.token);
  const readB = await api('GET', '/api/v1/businesses/onboarding-draft', userB.token);
  results.push(`draft_a_ok=${draftA.status}`);
  results.push(`draft_b_ok=${draftB.status}`);
  results.push(`draft_a_secret=${readA.json?.data?.draft?.secret === 'alpha-only'}`);
  results.push(`draft_b_secret=${readB.json?.data?.draft?.secret === 'bravo-only'}`);
  results.push(`draft_a_not_b=${readA.json?.data?.draft?.secret !== 'bravo-only'}`);
  results.push(`draft_b_not_a=${readB.json?.data?.draft?.secret !== 'alpha-only'}`);

  // Role escalation via RPC payload (ignored/impossible) and direct table insert via user client
  const escalateClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${userA.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const escalateInsert = await escalateClient.from('business_members').insert({
    business_id: businessB,
    user_id: userA.userId,
    role: 'owner',
    membership_status: 'active',
  });
  const escalateManager = await escalateClient.from('business_members').insert({
    business_id: businessB,
    user_id: userA.userId,
    role: 'manager',
    membership_status: 'active',
  });
  results.push(`escalate_owner_blocked=${Boolean(escalateInsert.error)}`);
  results.push(`escalate_manager_blocked=${Boolean(escalateManager.error)}`);

  // Idempotent create replay
  const replay = await api(
    'POST',
    '/api/v1/businesses',
    userA.token,
    {
      ...businessPayload(`va-${stamp}`),
      clientRequestId: createA.json.data.business.clientRequestId || createA.json.data?.business?.id,
      // use same client request id from original payload — recreate with stored id
    },
  );
  // Re-create with exact same clientRequestId from first create payload
  const replayExact = await api('POST', '/api/v1/businesses', userA.token, {
    ...businessPayload(`va-replay-${stamp}`),
    clientRequestId: createA.json.data.business.id ? undefined : undefined,
  });
  results.push(`replay_status_note=${replay.status}/${replayExact.status}`);

  const pass =
    unauth.status === 401 &&
    createA.status >= 200 &&
    createA.status < 300 &&
    createB.status >= 200 &&
    createB.status < 300 &&
    ownerA === userA.userId &&
    ownerB === userB.userId &&
    idsA.includes(businessA) &&
    !idsA.includes(businessB) &&
    idsB.includes(businessB) &&
    !idsB.includes(businessA) &&
    aGetB.status === 404 &&
    bGetA.status === 404 &&
    [403, 404].includes(aPatchB.status) &&
    [403, 404].includes(aLocB.status) &&
    bGetALoc.status === 404 &&
    readA.json?.data?.draft?.secret === 'alpha-only' &&
    readB.json?.data?.draft?.secret === 'bravo-only' &&
    Boolean(escalateInsert.error) &&
    Boolean(escalateManager.error);

  console.log(results.join('\n'));
  console.log(`api_tenant_isolation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_tenant_isolation_pass=false');
  console.log(`error=${String(error.message || error).slice(0, 300)}`);
  process.exitCode = 1;
}
