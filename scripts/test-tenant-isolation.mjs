/**
 * Cross-tenant isolation smoke test.
 * Creates two temporary users via Supabase Auth (anon key), creates one business each,
 * then verifies cross-access fails at API + RLS layers.
 * Does not print secrets or tokens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

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

if (!url || !anon) {
  console.log('skipped=true reason=missing_supabase_keys');
  process.exit(0);
}

const stamp = Date.now();
const password = `TestPass1!${stamp.toString().slice(-4)}`;

function makeEmail(tag) {
  // Avoid reserved domains like example.com (rejected by Supabase Auth validation).
  return `fadezy.phase03.${tag}.${stamp}@gmail.com`;
}

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

async function signup(tag) {
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = makeEmail(tag);
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: `Phase03 ${tag}` } },
  });
  if (error) {
    throw new Error(`signup_${tag}_failed:${error.message}`);
  }
  // If email confirm is required, session may be null — try password sign-in.
  let session = data.session;
  if (!session) {
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error || !signed.data.session) {
      throw new Error(`session_${tag}_unavailable_email_confirmation_required`);
    }
    session = signed.data.session;
  }
  return { client, email, token: session.access_token, userId: session.user.id };
}

function businessPayload(slug) {
  return {
    name: `Phase03 Shop ${slug}`,
    slug,
    businessType: 'barbershop',
    countryCode: 'US',
    defaultCurrency: 'USD',
    timezone: 'America/New_York',
    defaultLocale: 'en-US',
    clientRequestId: crypto.randomUUID(),
    primaryLocation: {
      name: 'Main',
      locationType: 'salon',
      city: 'Austin',
      countryCode: 'US',
      timezone: 'America/New_York',
      isPrimary: true,
    },
  };
}

const results = [];

try {
  const unauth = await api('POST', '/api/v1/businesses', null, businessPayload(`u-${stamp}`));
  results.push(`unauth_create_status=${unauth.status}`);

  const userA = await signup('a');
  const userB = await signup('b');

  const createA = await api('POST', '/api/v1/businesses', userA.token, businessPayload(`a-${stamp}`));
  const createB = await api('POST', '/api/v1/businesses', userB.token, businessPayload(`b-${stamp}`));
  results.push(`create_a_status=${createA.status}`);
  results.push(`create_b_status=${createB.status}`);

  if (!createA.json?.success || !createB.json?.success) {
    throw new Error('business_create_failed');
  }

  const businessA = createA.json.data.business.id;
  const businessB = createB.json.data.business.id;

  const aReadsB = await api('GET', `/api/v1/businesses/${businessB}`, userA.token);
  const bReadsA = await api('GET', `/api/v1/businesses/${businessA}`, userB.token);
  results.push(`a_read_b_status=${aReadsB.status}`);
  results.push(`b_read_a_status=${bReadsA.status}`);

  const aLocB = await api('GET', `/api/v1/businesses/${businessB}/locations`, userA.token);
  results.push(`a_locations_b_status=${aLocB.status}`);

  // Direct RLS check via user-scoped clients
  const scopedA = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${userA.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const scopedB = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${userB.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rlsAonB = await scopedA.from('businesses').select('id').eq('id', businessB).maybeSingle();
  const rlsBonA = await scopedB.from('businesses').select('id').eq('id', businessA).maybeSingle();
  results.push(`rls_a_sees_b=${Boolean(rlsAonB.data)}`);
  results.push(`rls_b_sees_a=${Boolean(rlsBonA.data)}`);

  const escalate = await scopedA.from('business_members').insert({
    business_id: businessB,
    user_id: userA.userId,
    role: 'owner',
    membership_status: 'active',
  });
  results.push(`role_escalation_blocked=${Boolean(escalate.error)}`);

  const pass =
    unauth.status === 401 &&
    createA.status >= 200 &&
    createA.status < 300 &&
    createB.status >= 200 &&
    createB.status < 300 &&
    aReadsB.status === 404 &&
    bReadsA.status === 404 &&
    aLocB.status === 404 &&
    !rlsAonB.data &&
    !rlsBonA.data &&
    Boolean(escalate.error);

  console.log(results.join('\n'));
  console.log(`tenant_isolation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log(`tenant_isolation_pass=false`);
  console.log(`error=${String(error.message || error).slice(0, 240)}`);
  process.exitCode = 1;
}
