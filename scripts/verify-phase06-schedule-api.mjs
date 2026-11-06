import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(import.meta.dirname, '..');
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const results = [];

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
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

if (!fs.existsSync(tokensPath)) {
  console.log('api_schedule_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const stamp = Date.now();

try {
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
  }
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0]?.id;
  const businessB = listB.json.data?.[0]?.id;
  const locationA = listA.json.data?.[0]?.primaryLocation?.id;
  if (!businessA || !businessB || !locationA) throw new Error('missing businesses/locations');

  const putHours = await api('PUT', `/api/v1/businesses/${businessA}/operating-hours`, tokens.a.token, {
    intervals: [
      { weekday: 1, startMinute: 540, endMinute: 720, sortOrder: 0 },
      { weekday: 1, startMinute: 780, endMinute: 1200, sortOrder: 1 },
      { weekday: 2, startMinute: 540, endMinute: 1200, sortOrder: 0 },
    ],
  });
  results.push(`put_business_hours=${putHours.status}`);

  const overlap = await api('PUT', `/api/v1/businesses/${businessA}/operating-hours`, tokens.a.token, {
    intervals: [
      { weekday: 3, startMinute: 540, endMinute: 900 },
      { weekday: 3, startMinute: 800, endMinute: 1000 },
    ],
  });
  results.push(`reject_overlap=${overlap.status}`);

  const overnight = await api('PUT', `/api/v1/businesses/${businessA}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday: 5, startMinute: 1320, endMinute: 1560 }],
  });
  results.push(`overnight_ok=${overnight.status}`);

  const locCustom = await api(
    'PUT',
    `/api/v1/businesses/${businessA}/locations/${locationA}/operating-hours`,
    tokens.a.token,
    { hoursMode: 'custom', intervals: [{ weekday: 1, startMinute: 600, endMinute: 1080 }] },
  );
  results.push(`location_custom=${locCustom.status}`);

  const cross = await api('GET', `/api/v1/businesses/${businessB}/operating-hours`, tokens.a.token);
  results.push(`cross_tenant_hours=${cross.status}`);

  const members = await api('GET', `/api/v1/businesses/${businessA}/members`, tokens.a.token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;

  // Ensure location assignment for owner before staff schedule
  if (ownerMembership) {
    await api('PUT', `/api/v1/businesses/${businessA}/members/${ownerMembership}/locations`, tokens.a.token, {
      locationIds: [locationA],
    });
    const staffSched = await api(
      'PUT',
      `/api/v1/businesses/${businessA}/members/${ownerMembership}/schedules`,
      tokens.a.token,
      {
        effectiveFrom: '2026-11-01',
        intervals: [{ weekday: 1, locationId: locationA, startMinute: 600, endMinute: 1080 }],
        breaks: [{ weekday: 1, startMinute: 720, endMinute: 750, isPaid: false }],
      },
    );
    results.push(`staff_schedule=${staffSched.status}`);
  } else {
    results.push('staff_schedule=skipped');
  }

  const closed = await api('POST', `/api/v1/businesses/${businessA}/schedule-exceptions`, tokens.a.token, {
    exceptionDate: '2026-12-25',
    kind: 'closed',
    locationId: locationA,
    label: `Closed ${stamp}`,
    intervals: [],
  });
  results.push(`closed_exception=${closed.status}`);

  const ctxClosed = await api(
    'GET',
    `/api/v1/businesses/${businessA}/availability/context?date=2026-12-25&locationId=${locationA}${ownerMembership ? `&membershipId=${ownerMembership}` : ''}`,
    tokens.a.token,
  );
  results.push(`context_closed=${ctxClosed.status}`);
  results.push(`context_location_open=${ctxClosed.json.data?.locationOpen}`);
  results.push(`context_source=${ctxClosed.json.data?.locationSource}`);

  const timeOff = await api('POST', `/api/v1/businesses/${businessA}/time-off`, tokens.a.token, {
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    isFullDay: true,
    category: 'vacation',
    locationId: locationA,
  });
  results.push(`time_off_create=${timeOff.status}`);

  const selfApprove = timeOff.json.data?.id
    ? await api(
        'POST',
        `/api/v1/businesses/${businessA}/time-off/${timeOff.json.data.id}/approve`,
        tokens.a.token,
      )
    : { status: 'skipped' };
  results.push(`self_approve=${selfApprove.status}`);

  const pass =
    putHours.status === 200 &&
    (overlap.status === 422 || overlap.status === 400) &&
    overnight.status === 200 &&
    locCustom.status === 200 &&
    (cross.status === 403 || cross.status === 404) &&
    (ownerMembership == null || results.includes('staff_schedule=200')) &&
    closed.status === 201 &&
    ctxClosed.status === 200 &&
    ctxClosed.json.data?.locationOpen === false &&
    ctxClosed.json.data?.locationSource === 'closed_exception' &&
    timeOff.status === 201 &&
    (selfApprove.status === 403 || selfApprove.status === 'skipped');

  console.log(results.join('\n'));
  console.log(`api_schedule_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('api_schedule_pass=false');
  console.error(String(error.message || error).slice(0, 500));
  process.exitCode = 1;
}
