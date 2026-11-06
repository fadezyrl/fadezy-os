import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

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

function key(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

if (!fs.existsSync(tokensPath)) {
  console.log('api_pos_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));

try {
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const k of ['a', 'b']) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: tokens[k].email,
      password: 'VerifyPass1!',
    });
    if (error) throw new Error(k + ' signin failed: ' + error.message);
    tokens[k].token = data.session.access_token;
  }

  const listA = await api('GET', '/api/v1/businesses', tokens.a.token);
  const businessA = listA.json.data?.[0];
  const locationA = businessA?.primaryLocation?.id;
  if (!businessA?.id || !locationA) throw new Error('missing business/location');

  const stamp = Date.now();
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
      name: `POS Cut ${stamp}`,
      durationMinutes: 30,
      processingMinutes: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceMinor: 2500,
      currency: businessA.defaultCurrency || 'USD',
      isActive: true,
      isBookableOnline: true,
    });
    serviceId = created.json.data?.id;
  }
  if (!serviceId || !ownerMembership) throw new Error('missing service/staff');

  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/locations`, tokens.a.token, {
    locationIds: [locationA],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/services`, tokens.a.token, {
    serviceIds: [serviceId],
  });

  // Tax settings
  const tax = await api('PATCH', `/api/v1/businesses/${businessA.id}/pos/tax-settings`, tokens.a.token, {
    taxEnabled: true,
    taxName: 'VAT',
    rateBps: 1000,
  });
  results.push(`tax_settings=${tax.status}`);

  // Register open
  const reg = await api('POST', `/api/v1/businesses/${businessA.id}/pos/register-sessions`, tokens.a.token, {
    locationId: locationA,
    openingFloatMinor: 10000,
  });
  results.push(`register_open=${reg.status}`);
  const sessionId = reg.json.data?.id;

  // Walk-in sale
  const saleKey = key('walkin');
  const sale = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
    notes: null,
    idempotencyKey: saleKey,
  });
  results.push(`walkin_create=${sale.status}`);
  const saleId = sale.json.data?.id;
  results.push(`tips_absent=${sale.json.data?.tipMinor === undefined}`);

  const saleReplay = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales`, tokens.a.token, {
    locationId: locationA,
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
    notes: null,
    idempotencyKey: saleKey,
  });
  results.push(`walkin_idempotent=${saleReplay.status === 201 || saleReplay.status === 200}`);
  results.push(`walkin_same_id=${saleReplay.json.data?.id === saleId}`);

  // Partial then full payment
  const total = sale.json.data?.totalMinor ?? 0;
  const half = Math.max(1, Math.floor(total / 2));
  const pay1 = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales/${saleId}/payments`, tokens.a.token, {
    amountMinor: half,
    methodKind: 'card_manual',
    idempotencyKey: key('pay1'),
  });
  results.push(`pay_partial=${pay1.status}`);
  results.push(`status_partial=${pay1.json.data?.status}`);

  // Line lock after payment
  const editAfterPay = await api('PATCH', `/api/v1/businesses/${businessA.id}/pos/sales/${saleId}`, tokens.a.token, {
    lines: [{ kind: 'service', sourceServiceId: serviceId, quantity: 1 }],
    discountMinor: 0,
  });
  results.push(`edit_after_pay=${editAfterPay.status}`);

  const remain = pay1.json.data?.balanceDueMinor ?? total - half;
  const pay2 = await api('POST', `/api/v1/businesses/${businessA.id}/pos/sales/${saleId}/payments`, tokens.a.token, {
    amountMinor: remain,
    methodKind: 'cash',
    idempotencyKey: key('pay2'),
  });
  results.push(`pay_cash=${pay2.status}`);
  results.push(`status_paid=${pay2.json.data?.status}`);
  const paymentId = pay2.json.data?.payments?.find((p) => p.methodKind === 'cash')?.id
    ?? pay2.json.data?.payments?.[0]?.id;

  // Over-refund protection
  const overRefund = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${saleId}/payments/${paymentId}/refunds`,
    tokens.a.token,
    { amountMinor: Number(pay2.json.data?.payments?.find((p) => p.id === paymentId)?.amountMinor ?? 0) + 1, reason: 'too much', idempotencyKey: key('overref') },
  );
  results.push(`over_refund=${overRefund.status}`);
  results.push(`over_refund_code=${overRefund.json.error?.code}`);

  // Booking checkout + void + replacement
  const timezone = businessA.primaryLocation?.timezone || 'UTC';
  const date = DateTime.now().setZone(timezone).plus({ days: 4 }).toISODate();
  const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
  await api('PUT', `/api/v1/businesses/${businessA.id}/operating-hours`, tokens.a.token, {
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/locations/${locationA}/operating-hours`, tokens.a.token, {
    hoursMode: 'custom',
    intervals: [{ weekday, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
  });
  await api('PUT', `/api/v1/businesses/${businessA.id}/members/${ownerMembership}/schedules`, tokens.a.token, {
    effectiveFrom: date,
    intervals: [{ weekday, locationId: locationA, startMinute: 540, endMinute: 1200, sortOrder: 0 }],
    breaks: [],
  });
  const customer = await api('POST', `/api/v1/businesses/${businessA.id}/customers`, tokens.a.token, {
    fullName: `POS Cust ${stamp}`,
  });
  const slots = await api(
    'GET',
    `/api/v1/businesses/${businessA.id}/booking-slots?date=${date}&locationId=${locationA}&serviceId=${serviceId}&staffMembershipId=${ownerMembership}`,
    tokens.a.token,
  );
  const startsAt = slots.json.data?.slots?.[0]?.startsAt;
  if (!startsAt) throw new Error('no slots');
  const booking = await api('POST', `/api/v1/businesses/${businessA.id}/bookings`, tokens.a.token, {
    locationId: locationA,
    staffMembershipId: ownerMembership,
    serviceId,
    addonIds: [],
    startsAt,
    customerId: customer.json.data.id,
    notes: null,
    idempotencyKey: key('bk'),
    channel: 'workspace',
  });
  results.push(`booking_create=${booking.status}`);
  const bookingId = booking.json.data?.id;

  const checkoutKey = key('checkout');
  const checkout = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`,
    tokens.a.token,
    { bookingId, discountMinor: 0, notes: null, idempotencyKey: checkoutKey },
  );
  results.push(`checkout=${checkout.status}`);
  const checkoutSaleId = checkout.json.data?.id;

  const dupCheckout = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`,
    tokens.a.token,
    { bookingId, discountMinor: 0, notes: null, idempotencyKey: key('checkout-dup') },
  );
  results.push(`dup_checkout=${dupCheckout.status}`);
  results.push(`dup_checkout_code=${dupCheckout.json.error?.code}`);

  const voided = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/${checkoutSaleId}/void`,
    tokens.a.token,
    { reason: 'wrong lines' },
  );
  results.push(`void=${voided.status}`);

  const voidReplay = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`,
    tokens.a.token,
    { bookingId, discountMinor: 0, notes: null, idempotencyKey: checkoutKey },
  );
  results.push(`void_same_key_status=${voidReplay.status}`);
  results.push(`void_same_key_voided=${voidReplay.json.data?.status === 'voided'}`);
  results.push(`void_same_key_id=${voidReplay.json.data?.id === checkoutSaleId}`);

  const replacement = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/sales/checkout-booking`,
    tokens.a.token,
    { bookingId, discountMinor: 0, notes: null, idempotencyKey: key('checkout-new') },
  );
  results.push(`replacement_checkout=${replacement.status}`);
  results.push(`replacement_new_id=${replacement.json.data?.id !== checkoutSaleId}`);

  // Concurrent checkout attempt SQL check via expected cash
  const pg = new Client({ connectionString: backendEnv.DATABASE_URL });
  await pg.connect();
  const expected = await pg.query('select public.register_session_expected_minor($1) as e', [sessionId]);
  const movements = await pg.query(
    `select kind, amount_minor from register_cash_movements where session_id=$1 order by created_at`,
    [sessionId],
  );
  const openFloatCount = movements.rows.filter((r) => r.kind === 'open_float').length;
  results.push(`open_float_count=${openFloatCount}`);
  results.push(`expected_minor=${expected.rows[0]?.e}`);

  // close register — counted should not change expected formula before close_count
  const expectedBeforeClose = Number(expected.rows[0]?.e);
  const closed = await api(
    'POST',
    `/api/v1/businesses/${businessA.id}/pos/register-sessions/${sessionId}/close`,
    tokens.a.token,
    { countedMinor: expectedBeforeClose + 50, discrepancyNote: 'test' },
  );
  results.push(`register_close=${closed.status}`);
  results.push(`expected_unchanged_by_count=${closed.json.data?.expectedMinor === expectedBeforeClose}`);
  results.push(`discrepancy=${closed.json.data?.discrepancyMinor === 50}`);
  await pg.end();

  // Cross business
  const listB = await api('GET', '/api/v1/businesses', tokens.b.token);
  const businessB = listB.json.data?.[0];
  const cross = await api(
    'GET',
    `/api/v1/businesses/${businessB.id}/pos/sales/${saleId}`,
    tokens.b.token,
  );
  results.push(`cross_sale=${cross.status}`);

  const pass =
    tax.status === 200 &&
    (reg.status === 201 || reg.status === 200) &&
    sale.status === 201 &&
    sale.json.data?.tipMinor === undefined &&
    (saleReplay.status === 200 || saleReplay.status === 201) &&
    saleReplay.json.data?.id === saleId &&
    pay1.status === 200 &&
    editAfterPay.status === 422 &&
    pay2.status === 200 &&
    overRefund.status === 422 &&
    checkout.status === 201 &&
    dupCheckout.status === 409 &&
    voided.status === 200 &&
    voidReplay.json.data?.status === 'voided' &&
    voidReplay.json.data?.id === checkoutSaleId &&
    replacement.status === 201 &&
    replacement.json.data?.id !== checkoutSaleId &&
    openFloatCount === 1 &&
    closed.json.data?.expectedMinor === expectedBeforeClose &&
    cross.status === 404;

  for (const line of results) console.log(line);
  console.log(`api_pos_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('api_pos_pass=false');
  console.log('error=' + String(error.message || error).slice(0, 600));
  for (const line of results) console.log(line);
  process.exitCode = 1;
}
