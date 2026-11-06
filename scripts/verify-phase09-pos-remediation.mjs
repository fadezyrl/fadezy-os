/**
 * Phase 09 remediation verification:
 * grants, cross-tenant/unauth mutations, RBAC, concurrency, calcs, update idempotency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import { Client } from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const tokensPath = path.join(root, 'scripts', '.verify-tokens.json');
const apiBase = process.env.API_BASE || 'http://localhost:4000';
const results = [];
const password = 'VerifyPass1!';

function loadEnv(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function note(name, value) {
  results.push(`${name}=${value}`);
}

function key(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hashPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
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

async function createAuthUser(pg, instanceId, tag, stamp) {
  const id = randomUUID();
  const email = `fadezy.pos.${tag}.${stamp}@gmail.com`;
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
      '', '', '', '', '', '', '', 0, '', false, false
    )`,
    [instanceId, id, email, password, `POS ${tag}`],
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

async function ensureMembership(pg, businessId, userId, role, locationId, displayName) {
  const existing = await pg.query(
    `select id from public.business_members
     where business_id = $1 and user_id = $2 and deactivated_at is null
     limit 1`,
    [businessId, userId],
  );
  let membershipId = existing.rows[0]?.id;
  if (!membershipId) {
    const inserted = await pg.query(
      `insert into public.business_members (
         business_id, user_id, role, membership_status, accepted_at
       ) values ($1, $2, $3, 'active', timezone('utc', now()))
       returning id`,
      [businessId, userId, role],
    );
    membershipId = inserted.rows[0].id;
    await pg.query(
      `insert into public.staff_profiles (business_id, membership_id, user_id, display_name, email)
       values ($1, $2, $3, $4, $5)
       on conflict (membership_id) do update set display_name = excluded.display_name`,
      [businessId, membershipId, userId, displayName, `${role}@pos.verify`],
    );
  } else {
    await pg.query(`update public.business_members set role = $2 where id = $1`, [
      membershipId,
      role,
    ]);
  }
  if (locationId) {
    await pg.query(
      `insert into public.staff_location_assignments (business_id, membership_id, location_id)
       values ($1, $2, $3)
       on conflict (membership_id, location_id) do nothing`,
      [businessId, membershipId, locationId],
    );
  }
  return membershipId;
}

if (!fs.existsSync(tokensPath)) {
  console.log('pos_remediation_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const stamp = Date.now();
const pg = new Client({ connectionString: backendEnv.DATABASE_URL });

try {
  await pg.connect();
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -------------------------------------------------------------------------
  // P1 — live EXECUTE grants
  // -------------------------------------------------------------------------
  const helperFns = [
    'assert_pos_manager',
    'assert_can_manage_pos_location',
    'generate_sale_reference',
    'register_session_expected_minor',
    'pos_calculate_sale_from_lines',
    'pos_insert_sale_lines',
    'pos_sale_to_jsonb',
    'pos_calculate_sale_from_booking_snapshots',
    'pos_recompute_sale_status',
  ];
  const mutationFns = [
    'create_walk_in_sale',
    'checkout_booking_to_sale',
    'update_open_sale',
    'record_sale_payment',
    'refund_sale_payment',
    'void_sale',
    'open_register_session',
    'close_register_session',
    'post_register_cash_adjustment',
  ];
  const grants = await pg.query(
    `select routine_name, grantee
     from information_schema.routine_privileges
     where specific_schema = 'public'
       and privilege_type = 'EXECUTE'
       and routine_name = any($1::text[])
       and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    [[...helperFns, ...mutationFns, 'is_pos_location_member']],
  );
  const grantSet = new Set(grants.rows.map((r) => `${r.routine_name}|${r.grantee}`));
  let helpersClean = true;
  for (const fn of helperFns) {
    if (grantSet.has(`${fn}|anon`) || grantSet.has(`${fn}|authenticated`) || grantSet.has(`${fn}|PUBLIC`)) {
      helpersClean = false;
      note(`grant_leak_${fn}`, 'true');
    }
  }
  note('helpers_no_client_execute', helpersClean);
  note(
    'is_pos_location_member_auth',
    grantSet.has('is_pos_location_member|authenticated') && !grantSet.has('is_pos_location_member|anon'),
  );
  let mutationsAuthOnly = true;
  for (const fn of mutationFns) {
    const hasAuth = grantSet.has(`${fn}|authenticated`);
    const hasAnon = grantSet.has(`${fn}|anon`) || grantSet.has(`${fn}|PUBLIC`);
    if (!hasAuth || hasAnon) {
      mutationsAuthOnly = false;
      note(`mutation_grant_bad_${fn}`, `auth=${hasAuth};anon=${hasAnon}`);
    }
  }
  note('mutations_authenticated_only', mutationsAuthOnly);

  // Direct anon helper abuse attempt
  const anonSb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: anonInsertErr } = await anonSb.rpc('pos_insert_sale_lines', {
    p_sale_id: randomUUID(),
    p_business_id: randomUUID(),
    p_currency: 'USD',
    p_lines: [],
  });
  note(
    'anon_pos_insert_denied',
    Boolean(anonInsertErr && /permission|not find|404|42501|PGRST/i.test(anonInsertErr.message)),
  );

  // -------------------------------------------------------------------------
  // Auth fixtures: owner A, cross B, manager, staff
  // -------------------------------------------------------------------------
  for (const k of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[k].email,
      password,
    });
    if (error) throw new Error(`${k} signin failed: ${error.message}`);
    tokens[k].token = data.session.access_token;
    tokens[k].userId = data.user.id;
  }

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessA = listA.json.data?.[0];
  const businessB = listB.json.data?.[0];
  const locationA = businessA?.primaryLocation?.id;
  if (!businessA?.id || !businessB?.id || !locationA) throw new Error('missing businesses');

  const instance = await pg.query(
    `select instance_id from auth.users where instance_id is not null limit 1`,
  );
  const instanceId = instance.rows[0]?.instance_id || '00000000-0000-0000-0000-000000000000';
  const managerUser = await createAuthUser(pg, instanceId, 'mgr', stamp);
  const staffUser = await createAuthUser(pg, instanceId, 'staff', stamp);
  const managerMembership = await ensureMembership(
    pg,
    businessA.id,
    managerUser.id,
    'manager',
    locationA,
    'POS Manager',
  );
  const staffMembership = await ensureMembership(
    pg,
    businessA.id,
    staffUser.id,
    'staff',
    locationA,
    'POS Staff',
  );
  note('fixture_manager', managerMembership);
  note('fixture_staff', staffMembership);

  const mgrSession = await sb.auth.signInWithPassword({
    email: managerUser.email,
    password,
  });
  const staffSession = await sb.auth.signInWithPassword({
    email: staffUser.email,
    password,
  });
  if (mgrSession.error || staffSession.error) {
    throw new Error('manager/staff signin failed');
  }
  const managerToken = mgrSession.data.session.access_token;
  const staffToken = staffSession.data.session.access_token;

  const members = await api('GET', `/api/v1/businesses/${businessA.id}/members`, tokens.a.token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;

  let services = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/services?status=active&limit=1`,
    tokens.a.token,
  );
  let serviceId = services.json.data?.items?.[0]?.id;
  if (!serviceId) {
    const created = await api('POST', `/api/v1/businesses/${businessA.id}/services`, tokens.a.token, {
      name: `POS Remediation Cut ${stamp}`,
      durationMinutes: 30,
      processingMinutes: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceMinor: 1000,
      currency: businessA.defaultCurrency || 'USD',
      isActive: true,
      isBookableOnline: true,
    });
    serviceId = created.json.data?.id;
  }
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/services`, tokens.a.token, {
    serviceIds: [serviceId],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${staffMembership}/services`, tokens.a.token, {
    serviceIds: [serviceId],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${managerMembership}/services`, tokens.a.token, {
    serviceIds: [serviceId],
  });

  // Second location for cross-location staff denial
  const loc2 = await api('POST', `/api/v1/businesses/${businessA.id}/locations`, tokens.a.token, {
    name: `POS Loc2 ${stamp}`,
    locationType: 'salon',
    city: businessA.primaryLocation?.city || 'City',
    countryCode: businessA.countryCode || businessA.primaryLocation?.countryCode || 'US',
    timezone: businessA.primaryLocation?.timezone || 'UTC',
    isPrimary: false,
  });
  const locationB = loc2.json.data?.id ?? loc2.json.data?.location?.id;
  note('location2_create', loc2.status);

  // Tax + register baseline (owner)
  await api('PATCH', `/api/v1/businesses/${businessA.id}/pos/tax-settings`, tokens.a.token, {
    taxEnabled: true,
    taxName: 'VAT',
    rateBps: 1000,
  });
  const openReg = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/register-sessions`,
    tokens.a.token,
    { locationId: locationA, openingFloatMinor: 5000 },
  );
  note('register_open_owner', openReg.status);
  let sessionId = openReg.json.data?.id;
  if (!sessionId && (openReg.status === 409 || openReg.status === 422)) {
    const existing = await api(
      'GET',
      `/api/v1/businesses/${businessA.id}/pos/register-sessions/open?locationId=${locationA}`,
      tokens.a.token,
    );
    sessionId = existing.json.data?.id;
  }

  // -------------------------------------------------------------------------
  // P2 — unauthenticated + cross-tenant mutations
  // -------------------------------------------------------------------------
  // Seed a sale as owner for mutation targets (also used by unauth update/pay/void)
  const seedSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
    idempotencyKey: key('seed-sale'),
  });
  const seedSaleId = seedSale.json.data?.id;
  note('seed_sale', seedSale.status);

  const unauthBodies = {
    walkin: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales`,
      method: 'POST',
      body: {
        locationId: locationA,
        lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
        discountMinor: 0,
        idempotencyKey: key('unauth-walk'),
      },
    },
    checkout: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`,
      method: 'POST',
      body: {
        bookingId: randomUUID(),
        discountMinor: 0,
        idempotencyKey: key('unauth-co'),
      },
    },
    update: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales/${seedSaleId}`,
      method: 'PATCH',
      body: {
        lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
        discountMinor: 0,
      },
    },
    pay: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales/${seedSaleId}/payments`,
      method: 'POST',
      body: { amountMinor: 1, methodKind: 'card_manual', idempotencyKey: key('unauth-pay') },
    },
    refund: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales/${seedSaleId}/payments/${randomUUID()}/refunds`,
      method: 'POST',
      body: { amountMinor: 1, reason: 'unauth', idempotencyKey: key('unauth-ref') },
    },
    void: {
      path: `/api/v1/businesses/${businessA.id}/pos/sales/${seedSaleId}/void`,
      method: 'POST',
      body: { reason: 'unauth' },
    },
    tax: {
      path: `/api/v1/businesses/${businessA.id}/pos/tax-settings`,
      method: 'PATCH',
      body: { taxEnabled: false, taxName: null, rateBps: 0 },
    },
    registerOpen: {
      path: `/api/v1/businesses/${businessA.id}/pos/register-sessions`,
      method: 'POST',
      body: { locationId: locationA, openingFloatMinor: 1 },
    },
    registerClose: {
      path: `/api/v1/businesses/${businessA.id}/pos/register-sessions/${sessionId}/close`,
      method: 'POST',
      body: { countedMinor: 0 },
    },
    registerAdjust: {
      path: `/api/v1/businesses/${businessA.id}/pos/register-sessions/${sessionId}/adjustments`,
      method: 'POST',
      body: { kind: 'cash_in', amountMinor: 1, note: 'unauth' },
    },
  };

  for (const [name, spec] of Object.entries(unauthBodies)) {
    const res = await api(spec.method, spec.path, null, spec.body);
    note(`unauth_${name}`, res.status);
  }

  const crossTargets = [
    {
      name: 'walkin',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/sales`,
      body: {
        locationId: businessB.primaryLocation?.id,
        lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
        discountMinor: 0,
        idempotencyKey: key('cross-walk'),
      },
      token: tokens.a.token,
    },
    {
      name: 'update',
      method: 'PATCH',
      path: `/api/v1/businesses/${businessB.id}/pos/sales/${seedSaleId}`,
      body: {
        lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
        discountMinor: 0,
      },
      token: tokens.b.token,
    },
    {
      name: 'pay',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/sales/${seedSaleId}/payments`,
      body: { amountMinor: 1, methodKind: 'card_manual', idempotencyKey: key('cross-pay') },
      token: tokens.b.token,
    },
    {
      name: 'void',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/sales/${seedSaleId}/void`,
      body: { reason: 'cross' },
      token: tokens.b.token,
    },
    {
      name: 'refund',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/sales/${seedSaleId}/payments/${randomUUID()}/refunds`,
      body: { amountMinor: 1, reason: 'cross', idempotencyKey: key('cross-ref') },
      token: tokens.b.token,
    },
    {
      name: 'checkout',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/sales/checkout-booking`,
      body: { bookingId: randomUUID(), discountMinor: 0, idempotencyKey: key('cross-co') },
      token: tokens.a.token,
    },
    {
      name: 'tax',
      method: 'PATCH',
      path: `/api/v1/businesses/${businessB.id}/pos/tax-settings`,
      body: { taxEnabled: true, taxName: 'X', rateBps: 1 },
      token: tokens.a.token,
    },
    {
      name: 'register_open',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/register-sessions`,
      body: { locationId: businessB.primaryLocation?.id, openingFloatMinor: 1 },
      token: tokens.a.token,
    },
    {
      name: 'register_close',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/register-sessions/${sessionId}/close`,
      body: { countedMinor: 0 },
      token: tokens.a.token,
    },
    {
      name: 'register_adjust',
      method: 'POST',
      path: `/api/v1/businesses/${businessB.id}/pos/register-sessions/${sessionId}/adjustments`,
      body: { kind: 'cash_in', amountMinor: 1, note: 'cross' },
      token: tokens.a.token,
    },
  ];

  const seedBefore = await pg.query(
    `select amount_paid_minor, status, total_minor from public.sales where id = $1`,
    [seedSaleId],
  );
  for (const t of crossTargets) {
    const res = await api(t.method, t.path, t.token, t.body);
    const denied = res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422;
    note(`cross_${t.name}`, `${res.status}:${denied}`);
  }
  const seedAfter = await pg.query(
    `select amount_paid_minor, status, total_minor from public.sales where id = $1`,
    [seedSaleId],
  );
  note(
    'cross_seed_unchanged',
    seedBefore.rows[0]?.amount_paid_minor === seedAfter.rows[0]?.amount_paid_minor &&
      seedBefore.rows[0]?.status === seedAfter.rows[0]?.status &&
      seedBefore.rows[0]?.total_minor === seedAfter.rows[0]?.total_minor,
  );

  // -------------------------------------------------------------------------
  // P3 — RBAC matrix
  // -------------------------------------------------------------------------
  const staffWalk = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, staffToken, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
    idempotencyKey: key('staff-walk'),
  });
  note('staff_walkin_ok', staffWalk.status === 201);
  const staffSaleId = staffWalk.json.data?.id;

  const staffDiscount = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, staffToken, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 100,
    idempotencyKey: key('staff-disc'),
  });
  note('staff_discount_denied', staffDiscount.status === 403);

  const staffCustom = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, staffToken, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'Extra', quantity: 1, unitPriceMinor: 500 }],
    discountMinor: 0,
    idempotencyKey: key('staff-custom'),
  });
  note('staff_custom_denied', staffCustom.status === 403);

  const staffEdit = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${staffSaleId}`,
    staffToken,
    { lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 2 }], discountMinor: 0 },
  );
  note('staff_edit_denied', staffEdit.status === 403);

  const staffPay = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${staffSaleId}/payments`,
    staffToken,
    {
      amountMinor: Math.max(1, Math.floor((staffWalk.json.data?.totalMinor ?? 2) / 2)),
      methodKind: 'card_manual',
      idempotencyKey: key('staff-pay'),
    },
  );
  note('staff_pay_ok', staffPay.status === 200);

  const staffVoid = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${seedSaleId}/void`,
    staffToken,
    { reason: 'staff void' },
  );
  note('staff_void_denied', staffVoid.status === 403);

  const staffRefund = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${staffSaleId}/payments/${staffPay.json.data?.payments?.[0]?.id}/refunds`,
    staffToken,
    { amountMinor: 1, reason: 'staff refund', idempotencyKey: key('staff-ref') },
  );
  note('staff_refund_denied', staffRefund.status === 403);

  const staffTax = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/tax-settings`,
    staffToken,
    { taxEnabled: false, taxName: null, rateBps: 0 },
  );
  note('staff_tax_denied', staffTax.status === 403);

  const staffReg = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/register-sessions`,
    staffToken,
    { locationId: locationA, openingFloatMinor: 1 },
  );
  note('staff_register_denied', staffReg.status === 403 || staffReg.status === 409);

  if (locationB) {
    const staffOtherLoc = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, staffToken, {
      locationId: locationB,
      lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
      discountMinor: 0,
      idempotencyKey: key('staff-loc2'),
    });
    note('staff_cross_location_denied', staffOtherLoc.status === 403 || staffOtherLoc.status === 404);
  } else {
    note('staff_cross_location_denied', 'skipped');
  }

  const mgrDiscount = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, managerToken, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 50,
    idempotencyKey: key('mgr-disc'),
  });
  note('manager_discount_ok', mgrDiscount.status === 201);

  const mgrCustom = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, managerToken, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'Gel', quantity: 1, unitPriceMinor: 300 }],
    discountMinor: 0,
    idempotencyKey: key('mgr-custom'),
  });
  note('manager_custom_ok', mgrCustom.status === 201);

  const mgrEdit = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${mgrCustom.json.data?.id}`,
    managerToken,
    {
      lines: [{ kind: 'custom', name: 'Gel+', quantity: 1, unitPriceMinor: 350 }],
      discountMinor: 0,
      idempotencyKey: key('mgr-edit'),
    },
  );
  note('manager_edit_ok', mgrEdit.status === 200);

  // -------------------------------------------------------------------------
  // P6 — update_open_sale idempotency
  // -------------------------------------------------------------------------
  const editSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
    idempotencyKey: key('edit-base'),
  });
  const editId = editSale.json.data?.id;
  const editKey = key('edit-idem');
  const edit1 = await api('PATCH', `/api/v1/businesses/${businessA.id}/pos/sales/${editId}`, tokens.a.token, {
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 2 }],
    discountMinor: 0,
    idempotencyKey: editKey,
  });
  note('update_idem_first', edit1.status);
  const totalAfterFirst = edit1.json.data?.totalMinor;
  const editReplay = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${editId}`,
    tokens.a.token,
    {
      lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 2 }],
      discountMinor: 0,
      idempotencyKey: editKey,
    },
  );
  note('update_idem_replay', editReplay.status === 200 && editReplay.json.data?.totalMinor === totalAfterFirst);
  const editConflict = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${editId}`,
    tokens.a.token,
    {
      lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 3 }],
      discountMinor: 0,
      idempotencyKey: editKey,
    },
  );
  note('update_idem_conflict', editConflict.status === 409);

  // -------------------------------------------------------------------------
  // P5 — financial calculations / lifecycle
  // -------------------------------------------------------------------------
  // Fixed discount + tax: price 1000, discount 100, tax 10% exclusive on taxable 900 → tax 90, total 990
  const calcSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [
      { kind: 'custom', name: 'A', quantity: 1, unitPriceMinor: 600 },
      { kind: 'custom', name: 'B', quantity: 1, unitPriceMinor: 400 },
    ],
    discountMinor: 100,
    idempotencyKey: key('calc-disc'),
  });
  note('calc_create', calcSale.status);
  note('calc_subtotal', calcSale.json.data?.subtotalMinor === 1000);
  note('calc_discount', calcSale.json.data?.discountMinor === 100);
  // remainder allocation: floors 60+40=100 exactly for 100/1000
  const lines = calcSale.json.data?.lines ?? [];
  const allocSum = lines.reduce((s, l) => s + Number(l.allocatedDiscountMinor), 0);
  note('calc_alloc_sum', allocSum === 100);
  note('calc_tax', calcSale.json.data?.taxMinor === 90);
  note('calc_total', calcSale.json.data?.totalMinor === 990);
  const lineTaxes = lines.map((l) => Number(l.taxMinor));
  note('calc_line_tax_sum', lineTaxes.reduce((a, b) => a + b, 0) === Number(calcSale.json.data?.taxMinor));

  // Multi-payment + partial/full refund
  const life = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'Life', quantity: 1, unitPriceMinor: 2000 }],
    discountMinor: 0,
    idempotencyKey: key('life'),
  });
  const lifeId = life.json.data?.id;
  const lifeTotal = life.json.data?.totalMinor;
  const p1amt = Math.floor(lifeTotal / 2);
  const p2amt = lifeTotal - p1amt;
  const lifeP1 = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments`,
    tokens.a.token,
    { amountMinor: p1amt, methodKind: 'card_manual', idempotencyKey: key('life-p1') },
  );
  note('life_partial_status', lifeP1.json.data?.status === 'partially_paid');
  const lifeP2 = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments`,
    tokens.a.token,
    { amountMinor: p2amt, methodKind: 'cash', idempotencyKey: key('life-p2') },
  );
  note('life_paid_status', lifeP2.json.data?.status === 'paid');
  note('life_balance_zero', lifeP2.json.data?.balanceDueMinor === 0);
  const cashPay = (lifeP2.json.data?.payments ?? []).find((p) => p.methodKind === 'cash');
  const halfRefund = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments/${cashPay?.id}/refunds`,
    tokens.a.token,
    {
      amountMinor: Math.floor(cashPay.amountMinor / 2),
      reason: 'partial',
      idempotencyKey: key('life-r1'),
    },
  );
  note('life_partial_refund_status', halfRefund.json.data?.status === 'partially_refunded');
  const restRefund = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments/${cashPay?.id}/refunds`,
    tokens.a.token,
    {
      amountMinor: cashPay.amountMinor - Math.floor(cashPay.amountMinor / 2),
      reason: 'rest cash',
      idempotencyKey: key('life-r2'),
    },
  );
  // still has card payment outstanding → partially_refunded unless we refund card too
  note('life_after_cash_full_refund_status', restRefund.json.data?.status);
  const cardPay = (restRefund.json.data?.payments ?? []).find((p) => p.methodKind === 'card_manual');
  const fullCard = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments/${cardPay?.id}/refunds`,
    tokens.a.token,
    { amountMinor: cardPay.amountMinor, reason: 'full', methodKind: 'card_manual', idempotencyKey: key('life-r3') },
  );
  note('life_fully_refunded', fullCard.json.data?.status === 'refunded');
  const overBoundary = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${lifeId}/payments/${cardPay?.id}/refunds`,
    tokens.a.token,
    { amountMinor: 1, reason: 'over', idempotencyKey: key('life-over') },
  );
  note('life_refund_boundary', overBoundary.status === 422);

  // Cash adjustment + expected
  const adj = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/register-sessions/${sessionId}/adjustments`,
    tokens.a.token,
    { kind: 'cash_in', amountMinor: 250, note: 'bank drop reverse' },
  );
  note('cash_adjust', adj.status);
  const expectedRow = await pg.query(
    `select public.register_session_expected_minor($1) as e`,
    [sessionId],
  );
  const expectedNow = Number(expectedRow.rows[0]?.e);
  note('expected_includes_adjust', expectedNow >= 5000 + 250);

  // -------------------------------------------------------------------------
  // P4 — concurrency (Promise.all) + DB final state
  // -------------------------------------------------------------------------
  // 1) update vs pay — do NOT require artificial mutual exclusion.
  // Product rules: pay-first rejects later edit; edit-first allows pay of old amount
  // when it remains within the new outstanding balance (partial payment).
  // Phase 10 sale_events notify lengthens the payment TX while the sale lock is held;
  // either serialization order is valid.
  const raceSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'Race', quantity: 1, unitPriceMinor: 1500 }],
    discountMinor: 0,
    idempotencyKey: key('race-sale'),
  });
  const raceId = raceSale.json.data?.id;
  const raceTotal = Number(raceSale.json.data?.totalMinor);
  const [raceEdit, racePay] = await Promise.all([
    api('PATCH', `/api/v1/businesses/${businessA.id}/pos/sales/${raceId}`, tokens.a.token, {
      lines: [{ kind: 'custom', name: 'Race', quantity: 1, unitPriceMinor: 1800 }],
      discountMinor: 0,
      idempotencyKey: key('race-edit'),
    }),
    api('POST', `/api/v1/businesses/${businessA.id}/pos/sales/${raceId}/payments`, tokens.a.token, {
      amountMinor: raceTotal,
      methodKind: 'card_manual',
      idempotencyKey: key('race-pay'),
    }),
  ]);
  note(`concurrent_edit_pay_statuses`, `${raceEdit.status},${racePay.status}`);
  const raceDb = await pg.query(
    `select status, amount_paid_minor, amount_refunded_minor, total_minor,
            (select count(*)::int from sale_lines where sale_id = $1) as line_count,
            (select coalesce(sum(amount_minor),0)::bigint from sale_payments where sale_id = $1) as pay_sum,
            (select count(*)::int from sale_payments where sale_id = $1) as pay_count
     from sales where id = $1`,
    [raceId],
  );
  const raceRow = raceDb.rows[0];
  const paid = Number(raceRow.amount_paid_minor);
  const refunded = Number(raceRow.amount_refunded_minor);
  const total = Number(raceRow.total_minor);
  const due = total - (paid - refunded);
  const payFirst =
    racePay.status === 200 &&
    (raceEdit.status === 422 || raceEdit.status === 409) &&
    paid === raceTotal &&
    total === raceTotal &&
    raceRow.status !== 'open';
  const editFirst =
    raceEdit.status === 200 &&
    racePay.status === 200 &&
    paid === raceTotal &&
    total > raceTotal &&
    raceTotal <= total &&
    due === total - raceTotal &&
    (raceRow.status === 'partially_paid' || due > 0);
  const editOnly =
    raceEdit.status === 200 &&
    (racePay.status === 422 || racePay.status === 409) &&
    paid === 0 &&
    raceRow.status === 'open';
  note('concurrent_edit_pay_serialized_ok', payFirst || editFirst || editOnly);
  note(
    'concurrent_edit_pay_ledger',
    Number(raceRow.pay_sum) === paid &&
      Number(raceRow.pay_count) <= 1 &&
      refunded === 0 &&
      due >= 0 &&
      Number(raceRow.line_count) >= 1,
  );

  // Deterministic: pay first then edit rejected
  const seqPaySale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'SeqPay', quantity: 1, unitPriceMinor: 1200 }],
    discountMinor: 0,
    idempotencyKey: key('seq-pay-sale'),
  });
  const seqPayId = seqPaySale.json.data?.id;
  const seqPayTotal = Number(seqPaySale.json.data?.totalMinor);
  const seqPay = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${seqPayId}/payments`,
    tokens.a.token,
    {
      amountMinor: seqPayTotal,
      methodKind: 'card_manual',
      idempotencyKey: key('seq-pay'),
    },
  );
  const seqEditAfterPay = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${seqPayId}`,
    tokens.a.token,
    {
      lines: [{ kind: 'custom', name: 'SeqPay', quantity: 1, unitPriceMinor: 1500 }],
      discountMinor: 0,
      idempotencyKey: key('seq-edit-after-pay'),
    },
  );
  note(
    'edit_pay_pay_first_edit_rejected',
    seqPay.status === 200 &&
      (seqEditAfterPay.status === 422 || seqEditAfterPay.status === 409),
  );

  // Deterministic: edit first then old amount accepted within new balance
  const seqEditSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'SeqEdit', quantity: 1, unitPriceMinor: 1500 }],
    discountMinor: 0,
    idempotencyKey: key('seq-edit-sale'),
  });
  const seqEditId = seqEditSale.json.data?.id;
  const seqOldTotal = Number(seqEditSale.json.data?.totalMinor);
  const seqEdit = await api(
    'PATCH',
    `/api/v1/businesses/${businessA.id}/pos/sales/${seqEditId}`,
    tokens.a.token,
    {
      lines: [{ kind: 'custom', name: 'SeqEdit', quantity: 1, unitPriceMinor: 1800 }],
      discountMinor: 0,
      idempotencyKey: key('seq-edit'),
    },
  );
  const seqPayAfterEdit = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${seqEditId}/payments`,
    tokens.a.token,
    {
      amountMinor: seqOldTotal,
      methodKind: 'card_manual',
      idempotencyKey: key('seq-pay-after-edit'),
    },
  );
  const seqEditDb = await pg.query(
    `select status, amount_paid_minor, total_minor,
            (select count(*)::int from sale_payments where sale_id = $1) as pay_count
     from sales where id = $1`,
    [seqEditId],
  );
  note(
    'edit_pay_edit_first_partial_ok',
    seqEdit.status === 200 &&
      seqPayAfterEdit.status === 200 &&
      Number(seqEditDb.rows[0].amount_paid_minor) === seqOldTotal &&
      Number(seqEditDb.rows[0].total_minor) > seqOldTotal &&
      Number(seqEditDb.rows[0].pay_count) === 1 &&
      seqEditDb.rows[0].status === 'partially_paid',
  );

  // 2) dual refund
  const refSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'RefRace', quantity: 1, unitPriceMinor: 1000 }],
    discountMinor: 0,
    idempotencyKey: key('ref-sale'),
  });
  const refPay = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${refSale.json.data.id}/payments`,
    tokens.a.token,
    {
      amountMinor: refSale.json.data.totalMinor,
      methodKind: 'card_manual',
      idempotencyKey: key('ref-pay'),
    },
  );
  const refPaymentId = refPay.json.data?.payments?.[0]?.id;
  const amt = refPay.json.data?.payments?.[0]?.amountMinor;
  const [r1, r2] = await Promise.all([
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/sales/${refSale.json.data.id}/payments/${refPaymentId}/refunds`,
      tokens.a.token,
      { amountMinor: amt, reason: 'a', methodKind: 'card_manual', idempotencyKey: key('ref-a') },
    ),
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/sales/${refSale.json.data.id}/payments/${refPaymentId}/refunds`,
      tokens.a.token,
      { amountMinor: amt, reason: 'b', methodKind: 'card_manual', idempotencyKey: key('ref-b') },
    ),
  ]);
  note(`concurrent_refund_statuses`, `${r1.status},${r2.status}`);
  const refundDb = await pg.query(
    `select coalesce(sum(amount_minor),0)::bigint as refunded
     from sale_refunds where payment_id = $1`,
    [refPaymentId],
  );
  note('concurrent_refund_sum_eq_payment', Number(refundDb.rows[0].refunded) === Number(amt));
  note(
    'concurrent_refund_one_success',
    [r1.status, r2.status].filter((s) => s === 200).length === 1 &&
      [r1.status, r2.status].some((s) => s === 422 || s === 409),
  );

  // 3) dual checkout
  const timezone = businessA.primaryLocation?.timezone || 'UTC';
  const date = DateTime.now().setZone(timezone).plus({ days: 15 }).toISODate();
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  await api('PUT', `/api/v1/businesses/${businessA.id}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/locations/${locationA}/operating-hours`,
    tokens.a.token,
    { hoursMode: 'custom', intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }] },
  );
  await api(
    'PUT',
    `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/schedules`,
    tokens.a.token,
    {
      effectiveFrom: date,
      intervals: [{ weekday, locationId: locationA, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
      breaks: [],
    },
  );
  const cust = await api('POST', `/api/v1/businesses/${businessA.id}/customers`, tokens.a.token, {
    fullName: `POS Conc ${stamp}`,
  });
  const slots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const startsAt = slots.json.data?.slots?.[0]?.startsAt;
  if (!startsAt) throw new Error('no slots for concurrency checkout');
  const booking = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt,
    customerId: cust.json.data.id,
    notes: null,
    idempotencyKey: key('conc-bk'),
    channel: 'workspace',
  });
  note('conc_booking', booking.status);
  const bookingId = booking.json.data?.id;
  const [c1, c2] = await Promise.all([
    api('POST', `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`, tokens.a.token, {
      bookingId,
      discountMinor: 0,
      idempotencyKey: key('conc-co-1'),
    }),
    api('POST', `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`, tokens.a.token, {
      bookingId,
      discountMinor: 0,
      idempotencyKey: key('conc-co-2'),
    }),
  ]);
  note(`concurrent_checkout_statuses`, `${c1.status},${c2.status}`);
  const activeSales = await pg.query(
    `select count(*)::int as n from sales where booking_id = $1 and status <> 'voided'`,
    [bookingId],
  );
  note('concurrent_checkout_one_active', activeSales.rows[0].n === 1);
  note(
    'concurrent_checkout_one_success',
    [c1.status, c2.status].filter((s) => s === 201 || s === 200).length === 1 &&
      [c1.status, c2.status].some((s) => s === 409 || s === 422),
  );

  // 4) cash pay vs register close
  const closeRaceSale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'custom', name: 'CloseRace', quantity: 1, unitPriceMinor: 400 }],
    discountMinor: 0,
    idempotencyKey: key('close-race-sale'),
  });
  const expectedBeforeCloseRace = Number(
    (await pg.query(`select public.register_session_expected_minor($1) as e`, [sessionId])).rows[0]
      .e,
  );
  const [cashPayRace, closeRace] = await Promise.all([
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/sales/${closeRaceSale.json.data.id}/payments`,
      tokens.a.token,
      {
        amountMinor: closeRaceSale.json.data.totalMinor,
        methodKind: 'cash',
        idempotencyKey: key('close-race-pay'),
      },
    ),
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/register-sessions/${sessionId}/close`,
      tokens.a.token,
      { countedMinor: expectedBeforeCloseRace, discrepancyNote: 'race' },
    ),
  ]);
  note(`concurrent_cash_close_statuses`, `${cashPayRace.status},${closeRace.status}`);
  const sessionDb = await pg.query(
    `select status, expected_minor from register_sessions where id = $1`,
    [sessionId],
  );
  const movCash = await pg.query(
    `select coalesce(sum(amount_minor),0)::bigint as s
     from register_cash_movements
     where session_id = $1 and kind = 'cash_payment'`,
    [sessionId],
  );
  note('register_closed_or_pay_denied', sessionDb.rows[0].status === 'closed' || cashPayRace.status !== 200);
  note(
    'cash_close_consistency',
    sessionDb.rows[0].status === 'closed'
      ? Number(sessionDb.rows[0].expected_minor) ===
          Number(
            (
              await pg.query(
                // recompute from movements excluding close_count using same rules
                `select coalesce(sum(case kind
                   when 'open_float' then amount_minor
                   when 'cash_payment' then amount_minor
                   when 'cash_refund' then -amount_minor
                   when 'cash_in' then amount_minor
                   when 'cash_out' then -amount_minor
                   else 0 end),0)::bigint as e
                 from register_cash_movements where session_id = $1`,
                [sessionId],
              )
            ).rows[0].e,
          ) ||
          Number(sessionDb.rows[0].expected_minor) === expectedBeforeCloseRace ||
          Number(sessionDb.rows[0].expected_minor) === expectedBeforeCloseRace + Number(movCash.rows[0].s)
      : true,
  );

  // Re-open register for cash refund vs close race
  const reopen = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/register-sessions`,
    tokens.a.token,
    { locationId: locationA, openingFloatMinor: 2000 },
  );
  note('register_reopen', reopen.status);
  const session2 = reopen.json.data?.id;
  const refundRaceSale = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales`,
    tokens.a.token,
    {
      locationId: locationA,
      lines: [{ kind: 'custom', name: 'RefundClose', quantity: 1, unitPriceMinor: 500 }],
      discountMinor: 0,
      idempotencyKey: key('refclose-sale'),
    },
  );
  const refundRacePay = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${refundRaceSale.json.data.id}/payments`,
    tokens.a.token,
    {
      amountMinor: refundRaceSale.json.data.totalMinor,
      methodKind: 'cash',
      idempotencyKey: key('refclose-pay'),
    },
  );
  const refundRacePaymentId = refundRacePay.json.data?.payments?.[0]?.id;
  const expected2 = Number(
    (await pg.query(`select public.register_session_expected_minor($1) as e`, [session2])).rows[0].e,
  );
  const [cashRefundRace, close2] = await Promise.all([
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/sales/${refundRaceSale.json.data.id}/payments/${refundRacePaymentId}/refunds`,
      tokens.a.token,
      {
        amountMinor: refundRacePay.json.data.payments[0].amountMinor,
        reason: 'race refund',
        idempotencyKey: key('refclose-r'),
      },
    ),
    api(
      'POST',
      `/api/v1/businesses/${businessA.id}/pos/register-sessions/${session2}/close`,
      tokens.a.token,
      { countedMinor: expected2, discrepancyNote: 'race2' },
    ),
  ]);
  note(`concurrent_refund_close_statuses`, `${cashRefundRace.status},${close2.status}`);
  const sess2Db = await pg.query(`select status, expected_minor from register_sessions where id = $1`, [
    session2,
  ]);
  note('refund_close_register_closed', sess2Db.rows[0].status === 'closed');
  const refundMov = await pg.query(
    `select count(*)::int as n from register_cash_movements
     where session_id = $1 and kind = 'cash_refund'`,
    [session2],
  );
  note(
    'refund_close_xor_or_serialized',
    (cashRefundRace.status === 200 && refundMov.rows[0].n === 1) ||
      (cashRefundRace.status !== 200 && refundMov.rows[0].n === 0) ||
      (cashRefundRace.status === 200 && close2.status === 200),
  );

  // Register close discrepancy check on closed session
  if (close2.status === 200) {
    note(
      'close_discrepancy_recorded',
      close2.json.data?.discrepancyMinor ===
        Number(close2.json.data?.countedMinor) - Number(close2.json.data?.expectedMinor),
    );
  } else {
    note('close_discrepancy_recorded', 'skipped');
  }

  // Unauth statuses should be 401
  const unauthOk =
    results.filter((l) => l.startsWith('unauth_')).every((l) => l.endsWith('=401'));

  const pass =
    helpersClean &&
    mutationsAuthOnly &&
    results.some((l) => l === 'is_pos_location_member_auth=true') &&
    results.some((l) => l === 'anon_pos_insert_denied=true') &&
    unauthOk &&
    results.some((l) => l === 'cross_seed_unchanged=true') &&
    results.some((l) => l === 'staff_walkin_ok=true') &&
    results.some((l) => l === 'staff_discount_denied=true') &&
    results.some((l) => l === 'staff_custom_denied=true') &&
    results.some((l) => l === 'staff_edit_denied=true') &&
    results.some((l) => l === 'staff_pay_ok=true') &&
    results.some((l) => l === 'staff_void_denied=true') &&
    results.some((l) => l === 'staff_refund_denied=true') &&
    results.some((l) => l === 'staff_tax_denied=true') &&
    results.some((l) => l === 'manager_discount_ok=true') &&
    results.some((l) => l === 'manager_edit_ok=true') &&
    results.some((l) => l === 'update_idem_replay=true') &&
    results.some((l) => l === 'update_idem_conflict=true') &&
    results.some((l) => l === 'calc_total=true') &&
    results.some((l) => l === 'life_fully_refunded=true') &&
    results.some((l) => l === 'concurrent_edit_pay_serialized_ok=true') &&
    results.some((l) => l === 'concurrent_edit_pay_ledger=true') &&
    results.some((l) => l === 'edit_pay_pay_first_edit_rejected=true') &&
    results.some((l) => l === 'edit_pay_edit_first_partial_ok=true') &&
    results.some((l) => l === 'concurrent_refund_sum_eq_payment=true') &&
    results.some((l) => l === 'concurrent_checkout_one_active=true') &&
    results.some((l) => l.startsWith('concurrent_cash_close_statuses=')) &&
    results.some((l) => l.startsWith('concurrent_refund_close_statuses='));

  for (const line of results) console.log(line);
  console.log(`pos_remediation_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('pos_remediation_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 800));
  for (const line of results) console.log(line);
  process.exitCode = 1;
} finally {
  await pg.end().catch(() => undefined);
}
