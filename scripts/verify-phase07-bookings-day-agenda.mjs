import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
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

/** Mirrors backend localDayUtcBounds — calendar day, not fixed 24h. */
function localDayUtcBounds(dateIso, timeZone) {
  const startLocal = DateTime.fromISO(dateIso, { zone: timeZone }).startOf('day');
  if (!startLocal.isValid) throw new Error(`invalid ${dateIso}/${timeZone}`);
  const endLocal = startLocal.plus({ days: 1 });
  return { startUtc: startLocal.toUTC(), endUtc: endLocal.toUTC() };
}

function assert(name, condition) {
  results.push(`${name}=${condition ? 'true' : 'false'}`);
  return condition;
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

// --- Pure bound checks ---
const tokyo = localDayUtcBounds('2026-11-06', 'Asia/Tokyo');
assert(
  'tokyo_morning_in_day',
  DateTime.fromISO('2026-11-06T00:30', { zone: 'Asia/Tokyo' }).toUTC() >= tokyo.startUtc &&
    DateTime.fromISO('2026-11-06T00:30', { zone: 'Asia/Tokyo' }).toUTC() < tokyo.endUtc,
);
assert(
  'tokyo_prev_evening_out',
  DateTime.fromISO('2026-11-05T23:30', { zone: 'Asia/Tokyo' }).toUTC() < tokyo.startUtc,
);

const auckland = localDayUtcBounds('2026-11-06', 'Pacific/Auckland');
assert(
  'auckland_morning_in_day',
  DateTime.fromISO('2026-11-06T00:30', { zone: 'Pacific/Auckland' }).toUTC() >= auckland.startUtc &&
    DateTime.fromISO('2026-11-06T00:30', { zone: 'Pacific/Auckland' }).toUTC() < auckland.endUtc,
);

const la = localDayUtcBounds('2026-11-06', 'America/Los_Angeles');
assert(
  'la_evening_in_day',
  DateTime.fromISO('2026-11-06T23:30', { zone: 'America/Los_Angeles' }).toUTC() >= la.startUtc &&
    DateTime.fromISO('2026-11-06T23:30', { zone: 'America/Los_Angeles' }).toUTC() < la.endUtc,
);

const honolulu = localDayUtcBounds('2026-11-06', 'Pacific/Honolulu');
assert(
  'honolulu_evening_in_day',
  DateTime.fromISO('2026-11-06T23:30', { zone: 'Pacific/Honolulu' }).toUTC() >= honolulu.startUtc &&
    DateTime.fromISO('2026-11-06T23:30', { zone: 'Pacific/Honolulu' }).toUTC() < honolulu.endUtc,
);

const utcDay = localDayUtcBounds('2026-11-06', 'UTC');
assert(
  'utc_morning_in_day',
  DateTime.fromISO('2026-11-06T00:30', { zone: 'UTC' }).toUTC() >= utcDay.startUtc &&
    DateTime.fromISO('2026-11-06T00:30', { zone: 'UTC' }).toUTC() < utcDay.endUtc,
);

// DST spring-forward 2026-03-08 America/New_York — local day is 23 hours
const spring = localDayUtcBounds('2026-03-08', 'America/New_York');
const springHours = spring.endUtc.diff(spring.startUtc, 'hours').hours;
assert('ny_spring_day_hours_23', Math.abs(springHours - 23) < 0.01);
assert(
  'ny_spring_after_gap_in_day',
  DateTime.fromISO('2026-03-08T03:30', { zone: 'America/New_York' }).toUTC() >= spring.startUtc &&
    DateTime.fromISO('2026-03-08T03:30', { zone: 'America/New_York' }).toUTC() < spring.endUtc,
);

// DST fall-back 2026-11-01 America/New_York — local day is 25 hours
const fall = localDayUtcBounds('2026-11-01', 'America/New_York');
const fallHours = fall.endUtc.diff(fall.startUtc, 'hours').hours;
assert('ny_fall_day_hours_25', Math.abs(fallHours - 25) < 0.01);
assert(
  'ny_fall_ambiguous_hour_in_day',
  DateTime.fromISO('2026-11-01T01:30', { zone: 'America/New_York' }).toUTC() >= fall.startUtc &&
    DateTime.fromISO('2026-11-01T01:30', { zone: 'America/New_York' }).toUTC() < fall.endUtc,
);

if (!fs.existsSync(tokensPath)) {
  console.log(results.join('\n'));
  console.log('day_agenda_pass=false');
  console.log('error=missing_tokens_file');
  process.exit(1);
}

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const backendEnv = loadEnv(path.join(root, 'backend', '.env'));
const pg = new Client({
  connectionString: backendEnv.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

let pass = results.every((line) => line.endsWith('=true'));

try {
  await pg.connect();
  const sb = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await sb.auth.signInWithPassword({
    email: tokens.a.email,
    password: 'VerifyPass1!',
  });
  if (authError) throw new Error(authError.message);
  const token = authData.session.access_token;

  const listA = await api('GET', '/api/v1/businesses', token);
  const business = listA.json.data?.[0];
  const locationId = business?.primaryLocation?.id;
  if (!business?.id || !locationId) throw new Error('missing business/location');

  const tzBefore = await pg.query(`select timezone from public.business_locations where id = $1`, [
    locationId,
  ]);
  const originalTimezone = tzBefore.rows[0]?.timezone || 'UTC';
  // Temporarily set location timezone for deterministic API checks
  await pg.query(`update public.business_locations set timezone = $2 where id = $1`, [
    locationId,
    'Asia/Tokyo',
  ]);

  const members = await api('GET', `/api/v1/businesses/${business.id}/members`, token);
  const ownerMembership = (members.json.data ?? []).find((m) => m.role === 'owner')?.membershipId;
  let services = await api('GET', `/api/v1/businesses/${business.id}/services`, token);
  let serviceId = services.json.data?.items?.[0]?.id;
  if (!serviceId) {
    const created = await api('POST', `/api/v1/businesses/${business.id}/services`, token, {
      name: `DayAgenda Cut ${Date.now()}`,
      durationMinutes: 30,
      processingMinutes: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceMinor: 1000,
      currency: business.defaultCurrency || 'USD',
      isActive: true,
      isBookableOnline: true,
    });
    serviceId = created.json.data?.id;
  }
  await api('PUT', `/api/v1/businesses/${business.id}/members/${ownerMembership}/locations`, token, {
    locationIds: [locationId],
  });
  await api('PUT', `/api/v1/businesses/${business.id}/members/${ownerMembership}/services`, token, {
    serviceIds: [serviceId],
  });

  const date = '2026-11-10';
  const weekday = DateTime.fromISO(date, { zone: 'Asia/Tokyo' }).weekday;
  await api('PUT', `/api/v1/businesses/${business.id}/locations/${locationId}/operating-hours`, token, {
    hoursMode: 'custom',
    intervals: [{ weekday, startMinute: 0, endMinute: 1440, sortOrder: 0 }],
  });
  await api('PUT', `/api/v1/businesses/${business.id}/members/${ownerMembership}/schedules`, token, {
    effectiveFrom: date,
    intervals: [{ weekday, locationId, startMinute: 0, endMinute: 1440, sortOrder: 0 }],
    breaks: [],
  });

  const customer = await api('POST', `/api/v1/businesses/${business.id}/customers`, token, {
    fullName: 'Day Agenda Verify',
    email: `day-agenda-${Date.now()}@example.com`,
  });

  const earlyLocal = DateTime.fromISO(`${date}T00:30:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  const lateLocal = DateTime.fromISO(`${date}T23:30:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  const otherDay = DateTime.fromISO(`2026-11-11T00:30:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  const rangeStart = DateTime.fromISO(`2026-11-10T00:00:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  const rangeEnd = DateTime.fromISO(`2026-11-13T00:00:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  // Remove leftover bookings in the fixture window so pagination counts stay deterministic.
  // Detach POS sales first — sales.booking_id is ON DELETE RESTRICT by design.
  await pg.query(
    `update public.sales
     set booking_id = null
     where booking_id in (
       select id from public.bookings
       where staff_membership_id = $1
         and busy_starts_at < $3::timestamptz
         and busy_ends_at > $2::timestamptz
     )`,
    [ownerMembership, rangeStart, rangeEnd],
  );
  await pg.query(
    `delete from public.booking_status_events
     where booking_id in (
       select id from public.bookings
       where staff_membership_id = $1
         and busy_starts_at < $3::timestamptz
         and busy_ends_at > $2::timestamptz
     )`,
    [ownerMembership, rangeStart, rangeEnd],
  );
  await pg.query(
    `delete from public.booking_addons
     where booking_id in (
       select id from public.bookings
       where staff_membership_id = $1
         and busy_starts_at < $3::timestamptz
         and busy_ends_at > $2::timestamptz
     )`,
    [ownerMembership, rangeStart, rangeEnd],
  );
  await pg.query(
    `delete from public.booking_services
     where booking_id in (
       select id from public.bookings
       where staff_membership_id = $1
         and busy_starts_at < $3::timestamptz
         and busy_ends_at > $2::timestamptz
     )`,
    [ownerMembership, rangeStart, rangeEnd],
  );
  await pg.query(
    `delete from public.bookings
     where staff_membership_id = $1
       and busy_starts_at < $3::timestamptz
       and busy_ends_at > $2::timestamptz`,
    [ownerMembership, rangeStart, rangeEnd],
  );

  async function createAt(startsAt, key) {
    // Bypass slot engine for boundary fixtures via direct insert (tests query path)
    const ends = DateTime.fromISO(startsAt, { zone: 'utc' }).plus({ minutes: 30 }).toISO();
    const ref = `DA${key}${Date.now().toString(36).slice(-6)}`.slice(0, 16).toUpperCase();
    const inserted = await pg.query(
      `insert into public.bookings (
        business_id, location_id, customer_id, staff_membership_id, status, channel,
        starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
        buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
        customer_name, location_name, staff_display_name,
        reference_code, idempotency_key, idempotency_payload_hash
      ) values (
        $1,$2,$3,$4,'confirmed','workspace',
        $5,$6,$5,$6,'Asia/Tokyo',
        0,0,'USD',1000,
        'Day Agenda Verify','Loc','Staff',
        $7,$8,$8
      ) returning id, starts_at`,
      [
        business.id,
        locationId,
        customer.json.data.id,
        ownerMembership,
        startsAt,
        ends,
        ref,
        `idem-day-${key}-${Date.now()}`,
      ],
    );
    return inserted.rows[0];
  }

  const early = await createAt(earlyLocal, 'E');
  const late = await createAt(lateLocal, 'L');
  const nextMorning = await createAt(otherDay, 'N');

  const missingLoc = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&limit=50`,
    token,
  );
  assert('date_requires_location', missingLoc.status === 422);

  const listed = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=50`,
    token,
  );
  assert('list_status', listed.status === 200);
  const ids = (listed.json.data ?? []).map((b) => b.id);
  assert('includes_tokyo_early', ids.includes(early.id));
  assert('includes_tokyo_late', ids.includes(late.id));
  assert('excludes_next_local_day', !ids.includes(nextMorning.id));

  // Reschedule next-day booking into selected local day and out again
  const intoDay = DateTime.fromISO(`${date}T12:00:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  await pg.query(
    `update public.bookings set starts_at=$2, ends_at=$3, busy_starts_at=$2, busy_ends_at=$3 where id=$1`,
    [
      nextMorning.id,
      intoDay,
      DateTime.fromISO(intoDay, { zone: 'utc' }).plus({ minutes: 30 }).toISO(),
    ],
  );
  const afterIn = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=50`,
    token,
  );
  assert(
    'reschedule_into_day_visible',
    (afterIn.json.data ?? []).some((b) => b.id === nextMorning.id),
  );

  const outDay = DateTime.fromISO(`2026-11-12T12:00:00`, { zone: 'Asia/Tokyo' }).toUTC().toISO();
  await pg.query(
    `update public.bookings set starts_at=$2, ends_at=$3, busy_starts_at=$2, busy_ends_at=$3 where id=$1`,
    [
      nextMorning.id,
      outDay,
      DateTime.fromISO(outDay, { zone: 'utc' }).plus({ minutes: 30 }).toISO(),
    ],
  );
  const afterOut = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=50`,
    token,
  );
  assert(
    'reschedule_out_of_day_hidden',
    !(afterOut.json.data ?? []).some((b) => b.id === nextMorning.id),
  );

  // Dense pagination: insert many on same local day, page without duplicates/omissions
  const denseIds = [];
  for (let i = 0; i < 7; i += 1) {
    const start = DateTime.fromISO(`${date}T0${i + 1}:00:00`, { zone: 'Asia/Tokyo' })
      .toUTC()
      .toISO();
    const row = await createAt(start, `P${i}`);
    denseIds.push(row.id);
  }
  const page1 = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=3&offset=0`,
    token,
  );
  const page2 = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=3&offset=3`,
    token,
  );
  const page3 = await api(
    'GET',
    `/api/v1/businesses/${business.id}/bookings?date=${date}&locationId=${locationId}&limit=3&offset=6`,
    token,
  );
  const p1 = (page1.json.data ?? []).map((b) => b.id);
  const p2 = (page2.json.data ?? []).map((b) => b.id);
  const p3 = (page3.json.data ?? []).map((b) => b.id);
  const combined = [...p1, ...p2, ...p3];
  assert('page_sizes', p1.length === 3 && p2.length === 3 && p3.length >= 1);
  assert('no_page_duplicates', new Set(combined).size === combined.length);
  assert(
    'dense_pages_cover_inserts',
    denseIds.every((id) => combined.includes(id)),
  );

  // Cleanup fixtures + restore timezone
  await pg.query(
    `update public.sales set booking_id = null where booking_id in (
       select id from public.bookings where customer_id = $1
     )`,
    [customer.json.data.id],
  );
  await pg.query(`delete from public.bookings where customer_id = $1`, [customer.json.data.id]);
  await pg.query(`delete from public.customers where id = $1`, [customer.json.data.id]);
  await pg.query(`update public.business_locations set timezone = $2 where id = $1`, [
    locationId,
    originalTimezone,
  ]);

  pass = results.every((line) => line.endsWith('=true'));
  console.log(results.join('\n'));
  console.log(`day_agenda_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log(results.join('\n'));
  console.log('day_agenda_pass=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await pg.end().catch(() => undefined);
}
