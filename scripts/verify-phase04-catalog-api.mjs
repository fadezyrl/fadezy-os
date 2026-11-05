/**
 * API catalog isolation using scripts/.verify-tokens.json (from Phase 03 bootstrap).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const results = [];

if (!fs.existsSync(tokensPath)) {
  console.log('api_catalog_pass=false');
  console.log('error=missing_tokens_file');
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

try {
  // Refresh sessions
  const { createClient } = await import('@supabase/supabase-js');
  function loadEnv(filePath) {
    const env = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      env[line.slice(0, i)] = line.slice(i + 1);
    }
    return env;
  }
  const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const key of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[key].email,
      password: 'VerifyPass1!',
    });
    if (error) throw new Error(key + ' signin failed: ' + error.message);
    tokens[key].token = data.session.access_token;
    tokens[key].userId = data.user.id;
  }
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0]?.id;
  const businessB = listB.json.data?.[0]?.id;
  if (!businessA || !businessB) throw new Error('missing businesses for A/B');

  const catA = await api('POST', `/api/v1/businesses/${businessA}/service-categories`, tokens.a.token, {
    name: `Cuts ${stamp}`,
  });
  const catB = await api('POST', `/api/v1/businesses/${businessB}/service-categories`, tokens.b.token, {
    name: `Nails ${stamp}`,
  });
  results.push(`create_cat_a=${catA.status}`);
  results.push(`create_cat_b=${catB.status}`);

  const svcA = await api('POST', `/api/v1/businesses/${businessA}/services`, tokens.a.token, {
    name: `Classic Cut ${stamp}`,
    categoryId: catA.json.data?.id,
    priceMinor: 2500,
    durationMinutes: 30,
  });
  results.push(`create_svc_a=${svcA.status}`);
  results.push(`svc_a_currency=${svcA.json.data?.currency}`);

  const badCurrency = await api('POST', `/api/v1/businesses/${businessA}/services`, tokens.a.token, {
    name: `Bad FX ${stamp}`,
    priceMinor: 100,
    durationMinutes: 15,
    currency: 'ZZZ',
  });
  results.push(`reject_wrong_currency=${badCurrency.status}`);

  const aListB = await api('GET', `/api/v1/businesses/${businessB}/services`, tokens.a.token);
  const aGetB = await api(
    'GET',
    `/api/v1/businesses/${businessB}/services/${svcA.json.data?.id || '00000000-0000-0000-0000-000000000000'}`,
    tokens.a.token,
  );
  const aPatchBCat = await api(
    'PATCH',
    `/api/v1/businesses/${businessB}/service-categories/${catB.json.data?.id}`,
    tokens.a.token,
    { name: 'hijack' },
  );
  results.push(`a_list_b_services=${aListB.status}`);
  results.push(`a_get_foreign_service=${aGetB.status}`);
  results.push(`a_patch_b_category=${aPatchBCat.status}`);

  const addonA = await api('POST', `/api/v1/businesses/${businessA}/service-addons`, tokens.a.token, {
    name: `Wash ${stamp}`,
    priceMinor: 500,
    durationMinutes: 10,
    serviceIds: svcA.json.data?.id ? [svcA.json.data.id] : [],
  });
  results.push(`create_addon_a=${addonA.status}`);

  const negPrice = await api('POST', `/api/v1/businesses/${businessA}/services`, tokens.a.token, {
    name: `Neg ${stamp}`,
    priceMinor: -1,
    durationMinutes: 10,
  });
  results.push(`reject_negative_price=${negPrice.status}`);

  const archive = await api(
    'DELETE',
    `/api/v1/businesses/${businessA}/services/${svcA.json.data.id}`,
    tokens.a.token,
  );
  results.push(`archive_svc=${archive.status}`);
  results.push(`archive_has_archived_at=${Boolean(archive.json.data?.archivedAt)}`);

  const aCannotAccessBList =
    [403, 404].includes(aListB.status) ||
    (aListB.status === 200 && (aListB.json.data?.items?.length ?? 0) === 0);

  const pass =
    catA.status === 201 &&
    catB.status === 201 &&
    svcA.status === 201 &&
    badCurrency.status === 422 &&
    aCannotAccessBList &&
    [403, 404].includes(aGetB.status) &&
    [403, 404].includes(aPatchBCat.status) &&
    addonA.status === 201 &&
    negPrice.status === 422 &&
    archive.status === 200 &&
    Boolean(archive.json.data?.archivedAt);

  console.log(results.join('\n'));
  console.log(`api_catalog_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_catalog_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 400));
  process.exitCode = 1;
}
