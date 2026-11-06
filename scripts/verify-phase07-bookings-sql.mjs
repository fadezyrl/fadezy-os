import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { DateTime } from 'luxon';

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
const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });
const results = [];

try {
  await client.connect();

  const tables = await client.query(`
    select count(*)::int as n
    from information_schema.tables
    where table_schema='public'
      and table_name in (
        'customers','bookings','booking_services','booking_addons','booking_status_events'
      )
  `);
  results.push(`booking_tables=${tables.rows[0].n}`);

  const excl = await client.query(`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conname = 'bookings_staff_busy_excl'
  `);
  results.push(`exclusion_present=${excl.rowCount === 1}`);
  results.push(
    `exclusion_half_open=${String(excl.rows[0]?.def || '').includes("'[)'")}`,
  );

  const rls = await client.query(`
    select relname, relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and relname in ('customers','bookings','booking_services','booking_addons','booking_status_events')
  `);
  results.push(
    `rls_enabled=${rls.rows.every((row) => row.relrowsecurity) && rls.rows.length === 5}`,
  );

  const biz = await client.query(`
    select b.id as business_id, l.id as location_id, l.timezone, m.id as membership_id
    from public.businesses b
    join public.business_locations l on l.business_id = b.id
    join public.business_members m on m.business_id = b.id and m.role = 'owner'
    order by b.created_at
    limit 1
  `);
  if (!biz.rowCount) throw new Error('no_seed_business');
  const { business_id, location_id, timezone, membership_id } = biz.rows[0];

  const customer = await client.query(
    `insert into public.customers (business_id, full_name, email)
     values ($1, 'Verify Customer', 'verify-booking@example.com')
     returning id`,
    [business_id],
  );
  const customerId = customer.rows[0].id;

  const day = DateTime.now().setZone(timezone).plus({ days: 1 }).toISODate();
  const start = DateTime.fromISO(`${day}T10:00:00`, { zone: timezone }).toUTC();
  const end = start.plus({ minutes: 30 });
  const busyStart = start.minus({ minutes: 5 });
  const busyEnd = end.plus({ minutes: 5 });

  const bookingA = await client.query(
    `insert into public.bookings (
      business_id, location_id, customer_id, staff_membership_id, status, channel,
      starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
      buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
      customer_name, location_name, staff_display_name,
      reference_code, idempotency_key, idempotency_payload_hash
    ) values (
      $1,$2,$3,$4,'confirmed','workspace',
      $5,$6,$7,$8,$9,
      5,5,'USD',1000,
      'Verify Customer','Loc','Staff',
      'BKVERIFY1','idem-verify-1','hash-1'
    ) returning id`,
    [
      business_id,
      location_id,
      customerId,
      membership_id,
      start.toISO(),
      end.toISO(),
      busyStart.toISO(),
      busyEnd.toISO(),
      timezone,
    ],
  );
  results.push(`insert_a=${Boolean(bookingA.rows[0]?.id)}`);

  let conflictOk = false;
  try {
    await client.query(
      `insert into public.bookings (
        business_id, location_id, customer_id, staff_membership_id, status, channel,
        starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
        buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
        customer_name, location_name, staff_display_name,
        reference_code, idempotency_key, idempotency_payload_hash
      ) values (
        $1,$2,$3,$4,'confirmed','workspace',
        $5,$6,$7,$8,$9,
        5,5,'USD',1000,
        'Verify Customer','Loc','Staff',
        'BKVERIFY2','idem-verify-2','hash-2'
      )`,
      [
        business_id,
        location_id,
        customerId,
        membership_id,
        start.plus({ minutes: 10 }).toISO(),
        end.plus({ minutes: 10 }).toISO(),
        busyStart.plus({ minutes: 10 }).toISO(),
        busyEnd.plus({ minutes: 10 }).toISO(),
        timezone,
      ],
    );
  } catch (error) {
    conflictOk = String(error.message || error).toLowerCase().includes('exclusion')
      || String(error.code) === '23P01';
  }
  results.push(`exclusion_blocks_overlap=${conflictOk}`);

  await client.query(`update public.bookings set status = 'cancelled' where id = $1`, [
    bookingA.rows[0].id,
  ]);
  const afterCancel = await client.query(
    `insert into public.bookings (
      business_id, location_id, customer_id, staff_membership_id, status, channel,
      starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
      buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
      customer_name, location_name, staff_display_name,
      reference_code, idempotency_key, idempotency_payload_hash
    ) values (
      $1,$2,$3,$4,'confirmed','workspace',
      $5,$6,$7,$8,$9,
      5,5,'USD',1000,
      'Verify Customer','Loc','Staff',
      'BKVERIFY3','idem-verify-3','hash-3'
    ) returning id`,
    [
      business_id,
      location_id,
      customerId,
      membership_id,
      start.toISO(),
      end.toISO(),
      busyStart.toISO(),
      busyEnd.toISO(),
      timezone,
    ],
  );
  results.push(`cancelled_releases_occupancy=${Boolean(afterCancel.rows[0]?.id)}`);

  await client.query(
    `insert into public.booking_services (
      booking_id, business_id, service_name, duration_minutes, processing_minutes, price_minor, currency
    ) values ($1,$2,'Cut',30,0,1000,'USD')`,
    [afterCancel.rows[0].id, business_id],
  );
  const snap = await client.query(
    `select service_name, duration_minutes from public.booking_services where booking_id = $1`,
    [afterCancel.rows[0].id],
  );
  results.push(`snapshot_persisted=${snap.rows[0]?.service_name === 'Cut'}`);

  // cleanup verify rows
  await client.query(`delete from public.bookings where reference_code like 'BKVERIFY%'`);
  await client.query(`delete from public.customers where id = $1`, [customerId]);

  const gap = DateTime.fromISO('2026-03-08T02:30:00', { zone: 'America/New_York' });
  results.push(`dst_gap_valid=${gap.isValid}`);

  const pass =
    tables.rows[0].n === 5 &&
    excl.rowCount === 1 &&
    conflictOk &&
    Boolean(afterCancel.rows[0]?.id) &&
    snap.rows[0]?.service_name === 'Cut';

  console.log(results.join('\n'));
  console.log(`sql_bookings_pass=${pass}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.log('sql_bookings_pass=false');
  console.error(String(error.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
