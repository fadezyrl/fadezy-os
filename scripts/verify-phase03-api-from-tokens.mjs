/**
 * Runs API tenant isolation using scripts/.verify-tokens.json from bootstrap-test-users.mjs
 * Does not print tokens.
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
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const results = [];

if (!fs.existsSync(tokensPath)) {
  console.log('api_tenant_isolation_pass=false');
  console.log('error=missing_tokens_file_run_bootstrap_first');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const stamp = Date.now();

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

function businessPayload(slug, requestId = crypto.randomUUID()) {
  return {
    name: `Verify Shop ${slug}`,
    slug,
    businessType: 'beauty_salon',
    countryCode: 'GB',
    defaultCurrency: 'GBP',
    timezone: 'Europe/London',
    defaultLocale: 'en-GB',
    clientRequestId: requestId,
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

try {
  const unauth = await api('POST', '/api/v1/businesses', null, businessPayload(`u-${stamp}`));
  results.push(`unauth_create=${unauth.status}`);

  const requestIdA = crypto.randomUUID();
  const requestIdB = crypto.randomUUID();
  const createA = await api(
    'POST',
    '/api/v1/businesses',
    tokens.a.token,
    businessPayload(`va-${stamp}`, requestIdA),
  );
  const createB = await api(
    'POST',
    '/api/v1/businesses',
    tokens.b.token,
    businessPayload(`vb-${stamp}`, requestIdB),
  );
  results.push(`create_a=${createA.status}`);
  results.push(`create_b=${createB.status}`);

  if (!createA.json?.success || !createB.json?.success) {
    throw new Error(
      `create_failed a=${JSON.stringify(createA.json?.error || createA.status)} b=${JSON.stringify(createB.json?.error || createB.status)}`,
    );
  }

  const businessA = createA.json.data.business.id;
  const businessB = createB.json.data.business.id;
  results.push(`owner_a_ok=${createA.json.data.membership.userId === tokens.a.userId}`);
  results.push(`owner_b_ok=${createB.json.data.membership.userId === tokens.b.userId}`);

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const idsA = (listA.json.data || []).map((b) => b.id);
  const idsB = (listB.json.data || []).map((b) => b.id);
  results.push(`list_a_has_a=${idsA.includes(businessA)}`);
  results.push(`list_a_has_b=${idsA.includes(businessB)}`);
  results.push(`list_b_has_b=${idsB.includes(businessB)}`);
  results.push(`list_b_has_a=${idsB.includes(businessA)}`);

  const aGetB = await api('GET', `/api/v1/businesses/${businessB}`, tokens.a.token);
  const bGetA = await api('GET', `/api/v1/businesses/${businessA}`, tokens.b.token);
  const aPatchB = await api('PATCH', `/api/v1/businesses/${businessB}`, tokens.a.token, {
    description: 'should-fail',
  });
  const aLocB = await api('POST', `/api/v1/businesses/${businessB}/locations`, tokens.a.token, {
    name: 'Intruder',
    locationType: 'salon',
    city: 'Paris',
    countryCode: 'FR',
    timezone: 'Europe/Paris',
    isPrimary: false,
  });
  const bLocA = await api('GET', `/api/v1/businesses/${businessA}/locations`, tokens.b.token);
  results.push(`a_get_b=${aGetB.status}`);
  results.push(`b_get_a=${bGetA.status}`);
  results.push(`a_patch_b=${aPatchB.status}`);
  results.push(`a_add_loc_b=${aLocB.status}`);
  results.push(`b_get_a_locs=${bLocA.status}`);

  const draftA = await api('PUT', '/api/v1/businesses/onboarding-draft', tokens.a.token, {
    draft: { secret: 'alpha-only', step: 2 },
  });
  const draftB = await api('PUT', '/api/v1/businesses/onboarding-draft', tokens.b.token, {
    draft: { secret: 'bravo-only', step: 3 },
  });
  const readA = await api('GET', '/api/v1/businesses/onboarding-draft', tokens.a.token);
  const readB = await api('GET', '/api/v1/businesses/onboarding-draft', tokens.b.token);
  results.push(`draft_put_a=${draftA.status}`);
  results.push(`draft_put_b=${draftB.status}`);
  results.push(`draft_a_secret_ok=${readA.json?.data?.draft?.secret === 'alpha-only'}`);
  results.push(`draft_b_secret_ok=${readB.json?.data?.draft?.secret === 'bravo-only'}`);
  results.push(`draft_isolated_a=${readA.json?.data?.draft?.secret !== 'bravo-only'}`);
  results.push(`draft_isolated_b=${readB.json?.data?.draft?.secret !== 'alpha-only'}`);

  // Duplicate submission / idempotent replay
  const replayA = await api(
    'POST',
    '/api/v1/businesses',
    tokens.a.token,
    businessPayload(`va-${stamp}`, requestIdA),
  );
  results.push(`idempotent_replay_a=${replayA.status}`);
  results.push(
    `idempotent_same_business=${replayA.json?.data?.business?.id === businessA || replayA.json?.data?.idempotentReplay === true}`,
  );

  const url = backendEnv.SUPABASE_URL?.trim();
  const anon = backendEnv.SUPABASE_ANON_KEY?.trim();
  const scopedA = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${tokens.a.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const escalateOwner = await scopedA.from('business_members').insert({
    business_id: businessB,
    user_id: tokens.a.userId,
    role: 'owner',
    membership_status: 'active',
  });
  const escalateManager = await scopedA.from('business_members').insert({
    business_id: businessB,
    user_id: tokens.a.userId,
    role: 'manager',
    membership_status: 'active',
  });
  results.push(`escalate_owner_blocked=${Boolean(escalateOwner.error)}`);
  results.push(`escalate_manager_blocked=${Boolean(escalateManager.error)}`);

  // Positive control: A can read own business
  const aGetA = await api('GET', `/api/v1/businesses/${businessA}`, tokens.a.token);
  results.push(`a_get_a=${aGetA.status}`);

  const pass =
    unauth.status === 401 &&
    createA.status >= 200 &&
    createA.status < 300 &&
    createB.status >= 200 &&
    createB.status < 300 &&
    idsA.includes(businessA) &&
    !idsA.includes(businessB) &&
    idsB.includes(businessB) &&
    !idsB.includes(businessA) &&
    aGetA.status === 200 &&
    aGetB.status === 404 &&
    bGetA.status === 404 &&
    [403, 404].includes(aPatchB.status) &&
    [403, 404].includes(aLocB.status) &&
    bLocA.status === 404 &&
    readA.json?.data?.draft?.secret === 'alpha-only' &&
    readB.json?.data?.draft?.secret === 'bravo-only' &&
    Boolean(escalateOwner.error) &&
    Boolean(escalateManager.error) &&
    (replayA.status === 200 || replayA.status === 201);

  console.log(results.join('\n'));
  console.log(`api_tenant_isolation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_tenant_isolation_pass=false');
  console.log(`error=${String(error.message || error).slice(0, 350)}`);
  process.exitCode = 1;
}
