/**
 * Phase 07 privilege remediation verification.
 * Proves: RPC grants, anon table denial, workspace/guest paths, no booking module pool usage at runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

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

function fail(msg) {
  results.push(`error=${msg}`);
  console.log(results.join('\n'));
  console.log('privilege_remediation_pass=false');
  process.exit(1);
}

const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
if (!fs.existsSync(tokensPath)) fail('missing_tokens_file');
const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));

// --- Static audit: booking module must not import getPgPool / availability-pg ---
const bookingDir = path.join(root, 'backend', 'src', 'modules', 'booking');
const bookingFiles = fs.readdirSync(bookingDir).filter((f) => f.endsWith('.ts'));
let poolImportHits = 0;
for (const file of bookingFiles) {
  const text = fs.readFileSync(path.join(bookingDir, file), 'utf8');
  if (/getPgPool|withTransaction|availability-pg|from ['\"]pg['\"]/.test(text)) {
    poolImportHits += 1;
    results.push(`pool_import_file=${file}`);
  }
}
results.push(`booking_pool_import_hits=${poolImportHits}`);
results.push(`availability_pg_exists=${fs.existsSync(path.join(bookingDir, 'availability-pg.ts'))}`);

const pg = new Client({
  connectionString: backendEnv.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

try {
  await pg.connect();

  const roleInfo = await pg.query(`
    select current_user, session_user,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls
  `);
  results.push(`inspect_role=${roleInfo.rows[0].current_user}`);
  results.push(`inspect_bypass_rls=${roleInfo.rows[0].bypass_rls}`);

  const grants = await pg.query(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_can_manage_booking_location',
        'create_workspace_booking',
        'reschedule_booking_times',
        'create_guest_booking',
        'guest_get_booking_slot_context',
        'list_staff_busy_ranges',
        'transition_booking_status'
      )
    order by 1
  `);
  for (const row of grants.rows) {
    results.push(
      `fn_grant=${row.proname};anon=${row.anon_exec};auth=${row.auth_exec};public=${row.public_exec}`,
    );
  }

  const expected = {
    assert_can_manage_booking_location: { anon: false, auth: false },
    create_workspace_booking: { anon: false, auth: true },
    reschedule_booking_times: { anon: false, auth: true },
    create_guest_booking: { anon: false, auth: false },
    guest_get_booking_slot_context: { anon: false, auth: false },
    list_staff_busy_ranges: { anon: false, auth: true },
    transition_booking_status: { anon: false, auth: true },
  };
  let grantsOk = true;
  for (const row of grants.rows) {
    const want = expected[row.proname];
    if (!want) continue;
    if (
      Boolean(row.anon_exec) !== want.anon ||
      Boolean(row.auth_exec) !== want.auth ||
      Boolean(row.public_exec) !== false
    ) {
      grantsOk = false;
      results.push(`grant_mismatch=${row.proname}`);
    }
  }
  results.push(`grants_ok=${grantsOk}`);

  // Anon cannot SELECT/INSERT bookings or customers via table privileges
  const tablePriv = await pg.query(`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon'
      and table_schema = 'public'
      and table_name in ('bookings', 'customers', 'booking_services', 'booking_addons', 'booking_status_events')
  `);
  results.push(`anon_table_grants=${tablePriv.rows.length}`);

  // Authenticated table privilege shape after grant hygiene
  const authTableExpected = {
    bookings: ['SELECT'],
    booking_services: ['SELECT'],
    booking_addons: ['SELECT'],
    booking_status_events: ['SELECT'],
    customers: ['SELECT', 'INSERT', 'UPDATE'],
  };
  let authTableOk = true;
  for (const [table, want] of Object.entries(authTableExpected)) {
    const have = [];
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const r = await pg.query(`select has_table_privilege($1, $2, $3) as ok`, [
        'authenticated',
        `public.${table}`,
        priv,
      ]);
      if (r.rows[0].ok) have.push(priv);
    }
    results.push(`auth_table=${table};privs=${have.join(',') || 'none'}`);
    if (have.join(',') !== want.join(',')) {
      authTableOk = false;
      results.push(`auth_table_mismatch=${table}`);
    }
  }
  results.push(`auth_table_grants_ok=${authTableOk}`);

  // Sign in users
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const key of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[key].email,
      password: 'VerifyPass1!',
    });
    if (error) throw new Error(`${key} signin failed: ${error.message}`);
    tokens[key].token = data.session.access_token;
  }

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0];
  const businessB = listB.json.data?.[0];
  const locationA = businessA?.primaryLocation?.id;
  if (!businessA?.id || !businessB?.id || !locationA) throw new Error('missing businesses');

  const members = await api('GET', `/api/v1/businesses/${businessA.id}/members`, tokens.a.token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;
  if (!ownerMembership) throw new Error('missing owner membership');

  let services = await api('GET', `/api/v1/businesses/${businessA.id}/services`, tokens.a.token);
  let serviceId = services.json.data?.items?.[0]?.id;
  if (!serviceId) {
    const createdService = await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/services`,
      tokens.a.token,
      {
        name: `Privilege Cut ${Date.now()}`,
        durationMinutes: 30,
        processingMinutes: 0,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 5,
        priceMinor: 2500,
        currency: businessA.defaultCurrency || 'USD',
        isActive: true,
        isBookableOnline: true,
      },
    );
    serviceId = createdService.json.data?.id;
  }
  if (!serviceId) throw new Error('missing service');

  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/locations`,
    tokens.a.token,
    { locationIds: [locationA] },
  );
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/services`,
    tokens.a.token,
    { serviceIds: [serviceId] },
  );

  const timezone = businessA.primaryLocation?.timezone || 'UTC';
  // Isolated from Phase 07 API (+9), Phase 08 (+11), and Phase 09 (+4) calendars.
  const date = DateTime.now().setZone(timezone).plus({ days: 13 }).toISODate();
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  await api('PUT', `/api/v1/businesses/${businessA.id}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/locations/${locationA}/operating-hours`,
    tokens.a.token,
    {
      hoursMode: 'custom',
      intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
    },
  );
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/schedules`,
    tokens.a.token,
    {
      effectiveFrom: date,
      intervals: [
        { weekday, locationId: locationA, startMinute: 540, endMinute: 1200, sortOrder: 0 },
      ],
      breaks: [],
    },
  );

  const existing = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/bookings?date=${date}&locationId=${locationA}&staffMembershipId=${ownerMembership}&status=confirmed&limit=100`,
    tokens.a.token,
  );
  for (const booking of existing.json.data ?? []) {
    if (!booking?.id) continue;
    await api(
      'POST',
      `/api/v1/businesses/${businessA.id}/bookings/${booking.id}/cancel`,
      tokens.a.token,
      { reason: 'phase07-privilege-cleanup' },
    );
  }

  // Unauthenticated workspace create must fail
  const unauth = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, null, {
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt: new Date().toISOString(),
    customer: { fullName: 'No Auth' },
    idempotencyKey: `unauth-${Date.now()}`,
    channel: 'workspace',
  });
  results.push(`unauth_workspace=${unauth.status}`);

  // Cross-business access fails
  const cross = await api('GET', `/api/v1/businesses/${businessB.id}/bookings`, tokens.a.token);
  results.push(`cross_business=${cross.status}`);

  // Workspace create via authenticated path
  const slots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  results.push(`workspace_slots=${slots.status};count=${slots.json.data?.slots?.length ?? 0}`);
  const firstSlot = slots.json.data?.slots?.[0]?.startsAt;
  if (!firstSlot) throw new Error('no workspace slots');

  const customer = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/customers`,
    tokens.a.token,
    { fullName: 'Privilege Owner Customer', email: `priv-${Date.now()}@example.com` },
  );
  const workspaceCreate = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/bookings`,
    tokens.a.token,
    {
      locationId: locationA,
      staffMembershipId: ownerMembership,
      serviceId,
      addonIds: [],
      startsAt: firstSlot,
      customerId: customer.json.data.id,
      notes: null,
      idempotencyKey: `priv-ws-${Date.now()}`,
      channel: 'workspace',
    },
  );
  results.push(`workspace_create=${workspaceCreate.status}`);
  results.push(`workspace_booking_id=${workspaceCreate.json.data?.id ?? ''}`);

  // Guest slots + create
  const guestSlots = await api(
    'GET',
    `/api/v1/public/booking/slots?businessSlug=${encodeURIComponent(businessA.slug)}&date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
  );
  results.push(`guest_slots=${guestSlots.status};count=${guestSlots.json.data?.slots?.length ?? 0}`);
  const guestSlot =
    guestSlots.json.data?.slots?.find((s) => s.startsAt !== firstSlot)?.startsAt ??
    guestSlots.json.data?.slots?.[1]?.startsAt ??
    guestSlots.json.data?.slots?.[0]?.startsAt;
  if (!guestSlot) throw new Error('no guest slots');

  const guestCreate = await api('POST', '/api/v1/public/booking/bookings', null, {
    businessSlug: businessA.slug,
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt: guestSlot,
    customer: { fullName: 'Guest Privilege', email: `guest-priv-${Date.now()}@example.com` },
    notes: null,
    idempotencyKey: `priv-guest-${Date.now()}`,
    channel: 'online',
  });
  results.push(`guest_create=${guestCreate.status}`);
  results.push(`guest_has_customer_email=${guestCreate.json.data?.customerEmail != null}`);
  results.push(`guest_has_customer_phone=${guestCreate.json.data?.customerPhone != null}`);
  results.push(`guest_customer_id_empty=${!guestCreate.json.data?.customerId}`);

  // Foreign identifiers rejected
  const foreignLoc = await api(
    'GET',
    `/api/v1/public/booking/slots?businessSlug=${encodeURIComponent(businessA.slug)}&date=${date}&locationId=${businessB.primaryLocation?.id}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
  );
  results.push(`foreign_location_slots=${foreignLoc.status}`);

  const foreignCreate = await api('POST', '/api/v1/public/booking/bookings', null, {
    businessSlug: businessA.slug,
    locationId: businessB.primaryLocation?.id,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt: guestSlot,
    customer: { fullName: 'Foreign' },
    idempotencyKey: `priv-foreign-${Date.now()}`,
    channel: 'online',
  });
  results.push(`foreign_location_create=${foreignCreate.status}`);

  // Direct anon PostgREST table access denied
  const anon = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonSelect = await anon.from('bookings').select('id').limit(1);
  const anonInsert = await anon.from('customers').insert({
    business_id: businessA.id,
    full_name: 'Should Fail',
  });
  results.push(`anon_bookings_select_error=${Boolean(anonSelect.error)}`);
  results.push(`anon_customers_insert_error=${Boolean(anonInsert.error)}`);

  // Unauthenticated RPC workspace create must fail at DB (auth.uid null)
  const anonRpc = await anon.rpc('create_workspace_booking', {
    p_business_id: businessA.id,
    p_location_id: locationA,
    p_staff_membership_id: ownerMembership,
    p_service_id: serviceId,
    p_addon_ids: [],
    p_starts_at: firstSlot,
    p_customer_id: null,
    p_customer_full_name: 'Hack',
    p_customer_email: null,
    p_customer_phone: null,
    p_customer_notes: null,
    p_notes: null,
    p_idempotency_key: `anon-rpc-${Date.now()}`,
    p_idempotency_payload_hash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  results.push(`anon_workspace_rpc_error=${Boolean(anonRpc.error)}`);

  const anonGuestRpc = await anon.rpc('create_guest_booking', {
    p_business_slug: businessA.slug,
    p_location_id: locationA,
    p_staff_membership_id: ownerMembership,
    p_service_id: serviceId,
    p_addon_ids: [],
    p_starts_at: firstSlot,
    p_customer_full_name: 'Anon Bypass',
    p_customer_email: null,
    p_customer_phone: null,
    p_notes: null,
    p_idempotency_key: `anon-guest-${Date.now()}`,
    p_idempotency_payload_hash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  results.push(`anon_guest_rpc_error=${Boolean(anonGuestRpc.error)}`);

  const anonBusy = await anon.rpc('list_staff_busy_ranges', {
    p_staff_membership_id: ownerMembership,
    p_from: new Date().toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  results.push(`anon_busy_ranges_error=${Boolean(anonBusy.error)}`);

  const anonTransition = await anon.rpc('transition_booking_status', {
    p_booking_id: workspaceCreate.json.data?.id ?? randomUUID(),
    p_to_status: 'cancelled',
    p_note: 'anon-should-fail',
  });
  results.push(`anon_transition_error=${Boolean(anonTransition.error)}`);

  // Rate limit still wired (guest route exists; soft check via 2 quick calls succeeding with 200/201/429)
  const rateA = await api(
    'GET',
    `/api/v1/public/booking/slots?businessSlug=${encodeURIComponent(businessA.slug)}&date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
  );
  results.push(`guest_rate_path_alive=${rateA.status === 200 || rateA.status === 429}`);

  const pass =
    poolImportHits === 0 &&
    !fs.existsSync(path.join(bookingDir, 'availability-pg.ts')) &&
    grantsOk &&
    authTableOk &&
    tablePriv.rows.length === 0 &&
    (unauth.status === 401 || unauth.status === 403) &&
    (cross.status === 403 || cross.status === 404) &&
    workspaceCreate.status === 201 &&
    guestSlots.status === 200 &&
    guestCreate.status === 201 &&
    guestCreate.json.data?.customerEmail == null &&
    guestCreate.json.data?.customerPhone == null &&
    !guestCreate.json.data?.customerId &&
    (foreignLoc.status === 404 || foreignLoc.status === 403 || foreignLoc.status === 422) &&
    (foreignCreate.status === 404 || foreignCreate.status === 403 || foreignCreate.status === 422) &&
    Boolean(anonSelect.error) &&
    Boolean(anonInsert.error) &&
    Boolean(anonRpc.error) &&
    Boolean(anonGuestRpc.error) &&
    Boolean(anonBusy.error) &&
    Boolean(anonTransition.error);

  console.log(results.join('\n'));
  console.log(`privilege_remediation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  fail(String(error.message || error).slice(0, 1000));
} finally {
  await pg.end().catch(() => undefined);
}
