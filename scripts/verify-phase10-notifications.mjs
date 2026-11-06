/**
 * Phase 10 notifications verification (SQL + worker RPCs + API inbox/prefs).
 * Delivery semantics documented as at-least-once — never exactly-once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import { Client } from 'pg';

const root = path.resolve(import.meta.dirname, '..');
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
  const email = `fadezy.notify.${tag}.${stamp}@gmail.com`;
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
    [instanceId, id, email, password, `Notify ${tag}`],
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

const env = loadEnv(path.join(root, 'backend', '.env'));
const pg = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 20000 });

try {
  await pg.connect();

  const tables = await pg.query(`
    select count(*)::int as n
    from information_schema.tables
    where table_schema='public'
      and table_name in (
        'notification_events','notification_deliveries','notification_delivery_attempts',
        'in_app_notifications','notification_schedules','notification_preferences'
      )
  `);
  note('notification_tables', tables.rows[0].n === 6);

  const role = await pg.query(`
    select rolcanlogin, rolsuper, rolbypassrls, rolinherit
    from pg_roles where rolname = 'fadezy_notify_worker'
  `);
  note('worker_role_exists', role.rowCount === 1);
  note('worker_not_super', role.rows[0]?.rolsuper === false);
  note('worker_no_bypass_rls', role.rows[0]?.rolbypassrls === false);

  const grants = await pg.query(`
    select
      has_table_privilege('fadezy_notify_worker', 'public.notification_events', 'SELECT') as events_select,
      has_table_privilege('fadezy_notify_worker', 'public.notification_deliveries', 'UPDATE') as deliveries_update,
      has_function_privilege('fadezy_notify_worker', 'public.claim_notification_deliveries(integer, text)', 'EXECUTE') as claim_exec,
      has_function_privilege('fadezy_notify_worker', 'public.worker_get_delivery_payload(uuid, text)', 'EXECUTE') as payload_exec,
      has_function_privilege('fadezy_notify_worker', 'public.complete_notification_delivery(uuid, text, text)', 'EXECUTE') as complete_exec,
      has_function_privilege('authenticated', 'public.emit_notification_event(uuid, text, text, uuid, text, jsonb, uuid)', 'EXECUTE') as auth_emit,
      has_function_privilege('anon', 'public.emit_notification_event(uuid, text, text, uuid, text, jsonb, uuid)', 'EXECUTE') as anon_emit,
      has_function_privilege('authenticated', 'public.claim_notification_deliveries(integer, text)', 'EXECUTE') as auth_claim,
      has_function_privilege('authenticated', 'public.complete_notification_delivery(uuid, text, text)', 'EXECUTE') as auth_complete
  `);
  const g = grants.rows[0];
  note('worker_no_events_select', g.events_select === false);
  note('worker_no_deliveries_update', g.deliveries_update === false);
  note('worker_claim_exec', g.claim_exec === true);
  note('worker_payload_exec', g.payload_exec === true);
  note('worker_complete_exec', g.complete_exec === true);
  note('auth_no_emit', g.auth_emit === false);
  note('anon_no_emit', g.anon_emit === false);
  note('auth_no_claim', g.auth_claim === false);
  note('auth_no_complete', g.auth_complete === false);

  const instance = await pg.query(
    `select instance_id from auth.users where instance_id is not null limit 1`,
  );
  const instanceId =
    instance.rows[0]?.instance_id || '00000000-0000-0000-0000-000000000000';
  const stamp = Date.now().toString(36);

  const owner = await createAuthUser(pg, instanceId, 'owner', stamp);
  const staff = await createAuthUser(pg, instanceId, 'staff', stamp);
  const outsider = await createAuthUser(pg, instanceId, 'out', stamp);

  const biz = await pg.query(
    `insert into public.businesses (
      name, slug, business_type, country_code, default_currency, timezone, default_locale,
      onboarding_status
    ) values (
      $1, $2, 'barbershop', 'US', 'USD', 'America/New_York', 'en-US', 'completed'
    ) returning id`,
    [`Notify Biz ${stamp}`, `notify-${stamp}`],
  );
  const businessId = biz.rows[0].id;

  const loc = await pg.query(
    `insert into public.business_locations (
      business_id, name, timezone, country_code, city, is_primary
    ) values ($1, 'Main', 'America/New_York', 'US', 'NYC', true)
    returning id`,
    [businessId],
  );
  const locationId = loc.rows[0].id;

  const ownerMem = await pg.query(
    `insert into public.business_members (
      business_id, user_id, role, membership_status, accepted_at
    ) values ($1, $2, 'owner', 'active', timezone('utc', now()))
    returning id`,
    [businessId, owner.id],
  );
  const staffMem = await pg.query(
    `insert into public.business_members (
      business_id, user_id, role, membership_status, accepted_at
    ) values ($1, $2, 'staff', 'active', timezone('utc', now()))
    returning id`,
    [businessId, staff.id],
  );
  const ownerMembershipId = ownerMem.rows[0].id;
  const staffMembershipId = staffMem.rows[0].id;
  await pg.query(
    `insert into public.staff_profiles (business_id, membership_id, user_id, display_name, email)
     values ($1,$2,$3,'Owner',$4), ($1,$5,$6,'Staff',$7)`,
    [
      businessId,
      ownerMembershipId,
      owner.id,
      owner.email,
      staffMembershipId,
      staff.id,
      staff.email,
    ],
  );

  const customer = await pg.query(
    `insert into public.customers (business_id, full_name, email)
     values ($1, 'Notify Customer', 'customer.notify@example.com')
     returning id`,
    [businessId],
  );
  const customerId = customer.rows[0].id;

  const starts = DateTime.now().setZone('America/New_York').plus({ days: 3 }).startOf('day').plus({ hours: 14 });
  const ends = starts.plus({ minutes: 45 });
  const booking = await pg.query(
    `insert into public.bookings (
      business_id, location_id, customer_id, staff_membership_id, status, channel,
      starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
      buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
      customer_name, customer_email, location_name, staff_display_name,
      reference_code, idempotency_key, idempotency_payload_hash
    ) values (
      $1,$2,$3,$4,'confirmed','workspace',
      $5,$6,$5,$6,'America/New_York',
      0,0,'USD',2500,
      'Notify Customer','customer.notify@example.com','Main','Staff',
      $7,$8,$9
    ) returning id`,
    [
      businessId,
      locationId,
      customerId,
      staffMembershipId,
      starts.toUTC().toISO(),
      ends.toUTC().toISO(),
      `NREF-${stamp}`,
      `idem-notify-${stamp}`,
      `hash-notify-${stamp}`,
    ],
  );
  const bookingId = booking.rows[0].id;

  // Atomic capture via status event trigger
  const evt1 = await pg.query(
    `insert into public.booking_status_events (
      business_id, booking_id, from_status, to_status, actor_user_id, note
    ) values ($1,$2,null,'confirmed',$3,null)
    returning id`,
    [businessId, bookingId, owner.id],
  );
  const createdEvents = await pg.query(
    `select id, event_type, idempotency_key from public.notification_events
     where business_id = $1 and entity_id = $2 and event_type = 'booking.created'`,
    [businessId, bookingId],
  );
  note('atomic_event_capture', createdEvents.rowCount === 1);

  // Idempotent replay of same created key via emit
  const replay = await pg.query(
    `select public.emit_notification_event(
      $1, 'booking.created', 'booking', $2, $3, '{"title":"x"}'::jsonb, $4
    ) as id`,
    [businessId, bookingId, createdEvents.rows[0].idempotency_key, owner.id],
  );
  note(
    'booking_idempotent_replay',
    replay.rows[0].id === createdEvents.rows[0].id && createdEvents.rowCount === 1,
  );

  const sched = await pg.query(
    `select fire_at, source_starts_at, status, idempotency_key
     from public.notification_schedules where booking_id = $1 and status = 'scheduled'`,
    [bookingId],
  );
  const expectedFire = starts.toUTC().minus({ hours: 24 }).toISO();
  const fireIso = DateTime.fromJSDate(sched.rows[0].fire_at).toUTC().toISO();
  note('reminder_scheduled', sched.rowCount === 1);
  note(
    'reminder_fire_equals_starts_minus_24h',
    fireIso === expectedFire ||
      Math.abs(DateTime.fromISO(fireIso).toMillis() - DateTime.fromISO(expectedFire).toMillis()) < 1000,
  );

  // Reschedule A→B→A with status-event id keys
  const startB = starts.plus({ hours: 1 });
  const endB = startB.plus({ minutes: 45 });
  await pg.query(
    `update public.bookings set starts_at = $2, ends_at = $3, busy_starts_at = $2, busy_ends_at = $3
     where id = $1`,
    [bookingId, startB.toUTC().toISO(), endB.toUTC().toISO()],
  );
  const resched1 = await pg.query(
    `insert into public.booking_status_events (
      business_id, booking_id, from_status, to_status, actor_user_id, note, previous_starts_at
    ) values ($1,$2,'confirmed','confirmed',$3,'rescheduled',$4)
    returning id`,
    [businessId, bookingId, owner.id, starts.toUTC().toISO()],
  );
  await pg.query(
    `update public.bookings set starts_at = $2, ends_at = $3, busy_starts_at = $2, busy_ends_at = $3
     where id = $1`,
    [bookingId, starts.toUTC().toISO(), ends.toUTC().toISO()],
  );
  const resched2 = await pg.query(
    `insert into public.booking_status_events (
      business_id, booking_id, from_status, to_status, actor_user_id, note, previous_starts_at
    ) values ($1,$2,'confirmed','confirmed',$3,'rescheduled',$4)
    returning id`,
    [businessId, bookingId, owner.id, startB.toUTC().toISO()],
  );
  const reschedEvents = await pg.query(
    `select id, idempotency_key from public.notification_events
     where business_id = $1 and event_type = 'booking.rescheduled' and entity_id = $2
     order by created_at`,
    [businessId, bookingId],
  );
  note('reschedule_a_b_a_two_events', reschedEvents.rowCount === 2);
  note(
    'reschedule_keys_use_status_event_ids',
    reschedEvents.rows[0].idempotency_key === `booking.rescheduled:${resched1.rows[0].id}` &&
      reschedEvents.rows[1].idempotency_key === `booking.rescheduled:${resched2.rows[0].id}`,
  );

  const activeSched = await pg.query(
    `select count(*)::int as n from public.notification_schedules
     where booking_id = $1 and status = 'scheduled'`,
    [bookingId],
  );
  const cancelledSched = await pg.query(
    `select count(*)::int as n from public.notification_schedules
     where booking_id = $1 and status = 'cancelled'`,
    [bookingId],
  );
  note('reminder_reschedule_cancels_old', cancelledSched.rows[0].n >= 1 && activeSched.rows[0].n === 1);

  // Materialize vs cancel concurrency: force due schedule then cancel in same booking lock path
  await pg.query(
    `update public.notification_schedules
     set fire_at = timezone('utc', now()) - interval '1 minute'
     where booking_id = $1 and status = 'scheduled'`,
    [bookingId],
  );
  const dueId = (
    await pg.query(
      `select id from public.notification_schedules where booking_id = $1 and status = 'scheduled' limit 1`,
      [bookingId],
    )
  ).rows[0].id;

  await pg.query('begin');
  await pg.query(`select id from public.notification_schedules where id = $1 for update`, [dueId]);
  await pg.query(`select public.cancel_booking_reminder_state($1)`, [bookingId]);
  await pg.query('commit');

  const afterCancel = await pg.query(
    `select status from public.notification_schedules where id = $1`,
    [dueId],
  );
  note(
    'materialize_cancel_race_safe',
    afterCancel.rows[0]?.status === 'cancelled',
  );

  // Fresh reminder for materialize success path
  await pg.query(
    `update public.bookings set status = 'confirmed', starts_at = $2, ends_at = $3
     where id = $1`,
    [bookingId, starts.toUTC().toISO(), ends.toUTC().toISO()],
  );
  await pg.query(`select public.schedule_booking_reminder_24h($1)`, [bookingId]);
  await pg.query(
    `update public.notification_schedules
     set fire_at = timezone('utc', now()) - interval '1 minute'
     where booking_id = $1 and status = 'scheduled'`,
    [bookingId],
  );
  const mat = await pg.query(`select public.materialize_due_notification_schedules(10) as n`);
  note('reminder_materialized', mat.rows[0].n >= 1);

  // Reminder recipient matrix: customer email only
  const reminderRecipients = await pg.query(
    `select d.channel, d.recipient_user_id, d.to_email
     from public.notification_deliveries d
     join public.notification_events e on e.id = d.event_id
     where e.business_id = $1 and e.event_type = 'booking.reminder.24h' and e.entity_id = $2`,
    [businessId, bookingId],
  );
  note(
    'reminder_customer_email_only',
    reminderRecipients.rows.length === 1 &&
      reminderRecipients.rows[0].channel === 'email' &&
      reminderRecipients.rows[0].to_email === 'customer.notify@example.com' &&
      reminderRecipients.rows[0].recipient_user_id == null,
  );
  note(
    'reminder_no_staff_or_manager_copy',
    reminderRecipients.rows.every((r) => r.channel === 'email' && !r.recipient_user_id),
  );

  // booking.created recipient matrix: customer email + staff in-app + owner in-app
  const createdRecipients = await pg.query(
    `select d.channel, d.recipient_user_id, d.to_email, d.template_key
     from public.notification_deliveries d
     join public.notification_events e on e.id = d.event_id
     where e.business_id = $1 and e.event_type = 'booking.created' and e.entity_id = $2
       and e.idempotency_key = $3`,
    [businessId, bookingId, createdEvents.rows[0].idempotency_key],
  );
  note(
    'created_has_customer_email',
    createdRecipients.rows.some(
      (r) => r.channel === 'email' && r.to_email === 'customer.notify@example.com',
    ),
  );
  note(
    'created_has_staff_in_app',
    createdRecipients.rows.some(
      (r) => r.channel === 'in_app' && r.recipient_user_id === staff.id,
    ),
  );
  note(
    'created_has_owner_in_app',
    createdRecipients.rows.some(
      (r) => r.channel === 'in_app' && r.recipient_user_id === owner.id,
    ),
  );

  // Insert pending email delivery for claim exclusivity + lease ownership
  const eventRow = await pg.query(
    `insert into public.notification_events (
      business_id, event_type, entity_type, entity_id, idempotency_key, payload
    ) values ($1, 'booking.created', 'booking', $2, $3, $4::jsonb)
    on conflict (business_id, idempotency_key) do update set payload = excluded.payload
    returning id`,
    [
      businessId,
      bookingId,
      `claim-test:${stamp}`,
      JSON.stringify({
        title: 'Claim test',
        body: 'x',
        businessName: 'Notify',
        customerEmail: 'customer.notify@example.com',
        startsAt: starts.toUTC().toISO(),
        timezone: 'America/New_York',
      }),
    ],
  );
  const delivery = await pg.query(
    `insert into public.notification_deliveries (
      event_id, business_id, channel, template_key, to_email, status
    ) values ($1, $2, 'email', 'booking_created_customer', 'customer.notify@example.com', 'pending')
    returning id`,
    [eventRow.rows[0].id, businessId],
  );
  const deliveryId = delivery.rows[0].id;

  // Isolate claim target: cancel other pending/failed emails in this business
  await pg.query(
    `update public.notification_deliveries
     set status = 'cancelled', skip_reason = 'verify_isolate'
     where business_id = $1
       and channel = 'email'
       and status in ('pending', 'failed')
       and id <> $2`,
    [businessId, deliveryId],
  );

  // service_role must not EXECUTE worker finalize RPCs
  const srGrants = await pg.query(
    `select count(*)::int as n
     from information_schema.routine_privileges
     where specific_schema = 'public'
       and privilege_type = 'EXECUTE'
       and grantee = 'service_role'
       and routine_name in (
         'complete_notification_delivery','fail_notification_delivery',
         'skip_notification_delivery','worker_get_delivery_payload',
         'claim_notification_deliveries','release_expired_delivery_leases',
         'materialize_due_notification_schedules'
       )`,
  );
  note('service_role_no_worker_exec', srGrants.rows[0].n === 0);

  if (env.NOTIFY_WORKER_DATABASE_URL?.trim()) {
    const workerA = new Client({
      connectionString: env.NOTIFY_WORKER_DATABASE_URL,
      connectionTimeoutMillis: 20000,
    });
    const workerB = new Client({
      connectionString: env.NOTIFY_WORKER_DATABASE_URL,
      connectionTimeoutMillis: 20000,
    });
    await workerA.connect();
    await workerB.connect();

    // Seed two pending rows for dual-claim exclusivity
    const dual1 = await pg.query(
      `insert into public.notification_deliveries (
         event_id, business_id, channel, template_key, to_email, status
       ) values ($1,$2,'email','booking_created_customer','dual1@example.com','pending')
       returning id`,
      [eventRow.rows[0].id, businessId],
    );
    const dual2 = await pg.query(
      `insert into public.notification_deliveries (
         event_id, business_id, channel, template_key, to_email, status
       ) values ($1,$2,'email','booking_created_customer','dual2@example.com','pending')
       returning id`,
      [eventRow.rows[0].id, businessId],
    );
    // Park every other claimable email so dual rows are the only candidates
    await pg.query(
      `update public.notification_deliveries
       set next_attempt_at = timezone('utc', now()) + interval '7 days'
       where channel = 'email'
         and status in ('pending', 'failed')
         and id not in ($1::uuid, $2::uuid)`,
      [dual1.rows[0].id, dual2.rows[0].id],
    );
    await pg.query(
      `update public.notification_deliveries
       set status = 'pending',
           next_attempt_at = timezone('utc', now()) - interval '1 minute',
           lease_owner = null,
           lease_expires_at = null
       where id in ($1::uuid, $2::uuid)`,
      [dual1.rows[0].id, dual2.rows[0].id],
    );
    const [claimA, claimB] = await Promise.all([
      workerA.query(`select id from public.claim_notification_deliveries(5, 'worker-a')`),
      workerB.query(`select id from public.claim_notification_deliveries(5, 'worker-b')`),
    ]);
    const idsA = new Set(claimA.rows.map((r) => r.id));
    const idsB = new Set(claimB.rows.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    note('dual_worker_claim_exclusive', overlap.length === 0);
    note(
      'dual_worker_claimed_target',
      (idsA.has(dual1.rows[0].id) || idsB.has(dual1.rows[0].id)) &&
        (idsA.has(dual2.rows[0].id) || idsB.has(dual2.rows[0].id)),
    );

    // Lease ownership: admin places an active lease; worker RPCs validate owner
    await pg.query(
      `update public.notification_deliveries
       set status = 'processing', lease_owner = 'owner-w',
           lease_expires_at = timezone('utc', now()) + interval '2 minutes',
           attempt_count = greatest(attempt_count, 1)
       where id = $1`,
      [deliveryId],
    );

    const wrongPayload = await workerB
      .query(`select public.worker_get_delivery_payload($1, $2) as payload`, [
        deliveryId,
        'other-w',
      ])
      .catch((e) => ({ error: e, rows: [] }));
    note('lease_wrong_owner_payload_rejected', Boolean(wrongPayload.error));

    const okPayload = await workerA.query(
      `select public.worker_get_delivery_payload($1, $2) as payload`,
      [deliveryId, 'owner-w'],
    );
    note('lease_owner_payload_ok', Boolean(okPayload.rows[0]?.payload));

    const wrongComplete = await workerB
      .query(`select public.complete_notification_delivery($1, $2, $3)`, [
        deliveryId,
        'msg',
        'other-w',
      ])
      .catch((e) => ({ error: e }));
    note('lease_wrong_owner_complete_rejected', Boolean(wrongComplete.error));

    await workerA.query(`select public.complete_notification_delivery($1, $2, $3)`, [
      deliveryId,
      'provider-1',
      'owner-w',
    ]);
    const sent = await pg.query(
      `select status from public.notification_deliveries where id = $1`,
      [deliveryId],
    );
    note('lease_owner_complete_ok', sent.rows[0].status === 'sent');

    const reComplete = await workerA
      .query(`select public.complete_notification_delivery($1, $2, $3)`, [
        deliveryId,
        'provider-2',
        'owner-w',
      ])
      .catch((e) => ({ error: e }));
    note('lease_already_complete_rejected', Boolean(reComplete.error));

    // Pending delivery rejected
    const pendingDel = await pg.query(
      `insert into public.notification_deliveries (
         event_id, business_id, channel, template_key, to_email, status
       ) values ($1, $2, 'email', 'booking_created_customer', 'pending@example.com', 'pending')
       returning id`,
      [eventRow.rows[0].id, businessId],
    );
    const pendingReject = await workerA
      .query(`select public.complete_notification_delivery($1, $2, $3)`, [
        pendingDel.rows[0].id,
        'x',
        'worker-a',
      ])
      .catch((e) => ({ error: e }));
    note('lease_pending_rejected', Boolean(pendingReject.error));

    // Expired lease rejected
    await pg.query(
      `update public.notification_deliveries
       set status = 'processing', lease_owner = 'worker-a',
           lease_expires_at = timezone('utc', now()) - interval '1 minute'
       where id = $1`,
      [pendingDel.rows[0].id],
    );
    const expiredReject = await workerA
      .query(`select public.worker_get_delivery_payload($1, $2)`, [
        pendingDel.rows[0].id,
        'worker-a',
      ])
      .catch((e) => ({ error: e }));
    note('lease_expired_rejected', Boolean(expiredReject.error));

    // Lease recovery + retry/dead
    const retryDel = await pg.query(
      `insert into public.notification_deliveries (
         event_id, business_id, channel, template_key, to_email, status
       ) values ($1, $2, 'email', 'booking_created_customer', 'retry@example.com', 'pending')
       returning id`,
      [eventRow.rows[0].id, businessId],
    );
    const retryId = retryDel.rows[0].id;
    await pg.query(
      `update public.notification_deliveries
       set next_attempt_at = timezone('utc', now()) + interval '7 days'
       where channel = 'email'
         and status in ('pending', 'failed')
         and id <> $1`,
      [retryId],
    );
    await pg.query(
      `update public.notification_deliveries
       set status = 'processing', lease_owner = 'dead-worker',
           lease_expires_at = timezone('utc', now()) - interval '1 minute',
           attempt_count = 1, next_attempt_at = timezone('utc', now())
       where id = $1`,
      [retryId],
    );
    const released = await workerA.query(`select public.release_expired_delivery_leases() as n`);
    note('lease_recovery_released', released.rows[0].n >= 1);
    // Ensure released row is the only due candidate
    await pg.query(
      `update public.notification_deliveries
       set next_attempt_at = timezone('utc', now()) + interval '7 days'
       where channel = 'email'
         and status in ('pending', 'failed')
         and id <> $1`,
      [retryId],
    );
    await pg.query(
      `update public.notification_deliveries
       set next_attempt_at = timezone('utc', now()) - interval '1 minute'
       where id = $1 and status in ('pending', 'failed')`,
      [retryId],
    );
    const reclaim = await workerA.query(
      `select id from public.claim_notification_deliveries(5, 'worker-recover')`,
    );
    note('lease_recovery_reclaim', reclaim.rows.some((r) => r.id === retryId));

    if (reclaim.rows.some((r) => r.id === retryId)) {
      await workerA.query(
        `select public.fail_notification_delivery($1, 'temp', true, 'worker-recover')`,
        [retryId],
      );
      const failed = await pg.query(
        `select status from public.notification_deliveries where id = $1`,
        [retryId],
      );
      note('retry_failed_status', failed.rows[0].status === 'failed');

      await pg.query(
        `update public.notification_deliveries
         set attempt_count = max_attempts, status = 'processing',
             lease_expires_at = timezone('utc', now()) + interval '2 minutes',
             lease_owner = 'worker-dead'
         where id = $1`,
        [retryId],
      );
      await workerA.query(
        `select public.fail_notification_delivery($1, 'permanent', true, 'worker-dead')`,
        [retryId],
      );
      const dead = await pg.query(
        `select status from public.notification_deliveries where id = $1`,
        [retryId],
      );
      note('retry_dead_after_max', dead.rows[0].status === 'dead');
    } else {
      // Fallback: place lease and fail directly (still validates owner path)
      await pg.query(
        `update public.notification_deliveries
         set status = 'processing', lease_owner = 'worker-recover',
             lease_expires_at = timezone('utc', now()) + interval '2 minutes',
             attempt_count = 1
         where id = $1`,
        [retryId],
      );
      await workerA.query(
        `select public.fail_notification_delivery($1, 'temp', true, 'worker-recover')`,
        [retryId],
      );
      const failed = await pg.query(
        `select status from public.notification_deliveries where id = $1`,
        [retryId],
      );
      note('retry_failed_status', failed.rows[0].status === 'failed');
      await pg.query(
        `update public.notification_deliveries
         set attempt_count = max_attempts, status = 'processing',
             lease_expires_at = timezone('utc', now()) + interval '2 minutes',
             lease_owner = 'worker-dead'
         where id = $1`,
        [retryId],
      );
      await workerA.query(
        `select public.fail_notification_delivery($1, 'permanent', true, 'worker-dead')`,
        [retryId],
      );
      const dead = await pg.query(
        `select status from public.notification_deliveries where id = $1`,
        [retryId],
      );
      note('retry_dead_after_max', dead.rows[0].status === 'dead');
    }

    await workerA.end().catch(() => undefined);
    await workerB.end().catch(() => undefined);
  } else {
    note('dual_worker_claim_exclusive', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('dual_worker_claimed_target', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_wrong_owner_payload_rejected', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_owner_payload_ok', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_wrong_owner_complete_rejected', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_pending_rejected', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_expired_rejected', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_owner_complete_ok', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_already_complete_rejected', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_recovery_released', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('lease_recovery_reclaim', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('retry_failed_status', 'SKIPPED_NO_NOTIFY_WORKER_URL');
    note('retry_dead_after_max', 'SKIPPED_NO_NOTIFY_WORKER_URL');
  }

  // Prefs defaults via API
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    note('api_inbox_tests', 'SKIPPED_NO_SUPABASE');
  } else {
    const auth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await auth.auth.signInWithPassword({ email: owner.email, password });
    const token = signIn.data.session?.access_token;
    note('owner_signin', Boolean(token));

    if (token) {
      // Seed in-app row
      const inAppEvent = await pg.query(
        `insert into public.notification_events (
          business_id, event_type, entity_type, entity_id, idempotency_key, payload
        ) values ($1,'booking.created','booking',$2,$3,'{"title":"Inbox","body":"Hello"}'::jsonb)
        returning id`,
        [businessId, bookingId, `inbox:${stamp}`],
      );
      const inAppDel = await pg.query(
        `insert into public.notification_deliveries (
          event_id, business_id, channel, template_key, recipient_user_id, status, sent_at
        ) values ($1,$2,'in_app','booking_staff_in_app',$3,'sent', timezone('utc', now()))
        returning id`,
        [inAppEvent.rows[0].id, businessId, owner.id],
      );
      const noteRow = await pg.query(
        `insert into public.in_app_notifications (
          delivery_id, business_id, user_id, title, body, href
        ) values ($1,$2,$3,'Inbox','Hello',$4)
        returning id`,
        [
          inAppDel.rows[0].id,
          businessId,
          owner.id,
          `/workspace/${businessId}`,
        ],
      );

      const list = await api('GET', `/api/v1/businesses/${businessId}/notifications`, token);
      note('inbox_list_ok', list.status === 200 && list.json?.success === true);
      note(
        'inbox_unread_count',
        (list.json?.data?.meta?.unreadCount ?? 0) >= 1,
      );

      const mark = await api(
        'POST',
        `/api/v1/businesses/${businessId}/notifications/${noteRow.rows[0].id}/read`,
        token,
        { read: true },
      );
      note('inbox_mark_read', mark.status === 200 && mark.json?.data?.readAt);

      const prefs = await api(
        'GET',
        `/api/v1/businesses/${businessId}/notification-preferences`,
        token,
      );
      const emailPref = (prefs.json?.data ?? []).find(
        (p) => p.eventType === 'booking.created' && p.channel === 'email',
      );
      const inAppPref = (prefs.json?.data ?? []).find(
        (p) => p.eventType === 'booking.created' && p.channel === 'in_app',
      );
      note('pref_email_default_off', emailPref?.enabled === false);
      note('pref_in_app_default_on', inAppPref?.enabled === true);

      const patch = await api(
        'PATCH',
        `/api/v1/businesses/${businessId}/notification-preferences`,
        token,
        {
          preferences: [
            { eventType: 'booking.created', channel: 'email', enabled: true },
          ],
        },
      );
      note('pref_patch_ok', patch.status === 200);

      // Outsider must not list
      const outSign = await auth.auth.signInWithPassword({
        email: outsider.email,
        password,
      });
      const outToken = outSign.data.session?.access_token;
      const denied = await api(
        'GET',
        `/api/v1/businesses/${businessId}/notifications`,
        outToken,
      );
      note('location_authz_outsider_denied', denied.status === 404 || denied.json?.success === false);

      // No send-arbitrary API
      const sendAttempt = await api(
        'POST',
        `/api/v1/businesses/${businessId}/notifications/send`,
        token,
        { to: 'x@y.com', subject: 'nope' },
      );
      note('no_arbitrary_send_api', sendAttempt.status === 404 || sendAttempt.status === 405);
    }
  }

  // Staff recipient presence from created booking
  const staffDel = await pg.query(
    `select count(*)::int as n
     from public.notification_deliveries d
     join public.notification_events e on e.id = d.event_id
     where e.business_id = $1
       and e.event_type = 'booking.created'
       and e.entity_id = $2
       and d.channel = 'in_app'
       and d.recipient_user_id = $3`,
    [businessId, bookingId, staff.id],
  );
  note('staff_in_app_recipient', staffDel.rows[0].n >= 1);

  const custEmail = await pg.query(
    `select count(*)::int as n
     from public.notification_deliveries d
     join public.notification_events e on e.id = d.event_id
     where e.entity_id = $1 and e.event_type = 'booking.created'
       and d.channel = 'email' and d.to_email = 'customer.notify@example.com'`,
    [bookingId],
  );
  note('customer_email_recipient', custEmail.rows[0].n >= 1);

  note('delivery_semantics', 'at_least_once');
} catch (error) {
  note('verify_failed', true);
  console.error(String(error?.stack || error).slice(0, 2000));
  process.exitCode = 1;
} finally {
  await pg.end().catch(() => undefined);
}

for (const line of results) console.log(line);
const hardFail = results.some(
  (line) => /=false$/.test(line) || line === 'verify_failed=true',
);
if (hardFail) {
  console.log('phase10_notifications_verify=FAIL');
  process.exitCode = 1;
} else {
  console.log('phase10_notifications_verify=PASS');
}
