-- Phase 10 v1: fadezy_notify_worker role + claim/complete/fail/release/materialize RPCs

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fadezy_notify_worker') then
    create role fadezy_notify_worker
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls
      noreplication
      noinherit;
  end if;
end
$$;

grant connect on database postgres to fadezy_notify_worker;
grant usage on schema public to fadezy_notify_worker;

-- No table DML grants — worker uses RPCs only
revoke all on table public.notification_events from fadezy_notify_worker;
revoke all on table public.notification_deliveries from fadezy_notify_worker;
revoke all on table public.notification_delivery_attempts from fadezy_notify_worker;
revoke all on table public.notification_schedules from fadezy_notify_worker;
revoke all on table public.in_app_notifications from fadezy_notify_worker;
revoke all on table public.notification_preferences from fadezy_notify_worker;

create or replace function public.release_expired_delivery_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries
  set status = case when attempt_count > 0 then 'failed'::public.notification_delivery_status
                    else 'pending'::public.notification_delivery_status end,
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = timezone('utc', now())
  where status = 'processing'
    and lease_expires_at is not null
    and lease_expires_at < timezone('utc', now());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_notification_deliveries(
  p_limit integer,
  p_worker_id text
)
returns setof public.notification_deliveries
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select d.id
    from public.notification_deliveries d
    where d.channel = 'email'
      and d.status in ('pending', 'failed')
      and d.next_attempt_at <= timezone('utc', now())
      and (d.lease_expires_at is null or d.lease_expires_at < timezone('utc', now()))
    order by d.next_attempt_at
    for update skip locked
    limit greatest(coalesce(p_limit, 10), 1)
  )
  update public.notification_deliveries d
  set status = 'processing',
      lease_owner = left(coalesce(p_worker_id, 'worker'), 120),
      lease_expires_at = timezone('utc', now()) + interval '2 minutes',
      attempt_count = d.attempt_count + 1
  from candidates c
  where d.id = c.id
  returning d.*;
end;
$$;

create or replace function public.complete_notification_delivery(
  p_delivery_id uuid,
  p_provider_message_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  select * into v_row from public.notification_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;

  update public.notification_deliveries
  set status = 'sent',
      provider_message_id = nullif(trim(p_provider_message_id), ''),
      lease_owner = null,
      lease_expires_at = null,
      sent_at = timezone('utc', now()),
      last_error = null
  where id = p_delivery_id;

  insert into public.notification_delivery_attempts (
    delivery_id, attempt_number, outcome, provider_status
  ) values (
    p_delivery_id, v_row.attempt_count, 'sent', 'ok'
  );
end;
$$;

create or replace function public.fail_notification_delivery(
  p_delivery_id uuid,
  p_error text,
  p_retryable boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_deliveries%rowtype;
  v_next timestamptz;
  v_status public.notification_delivery_status;
  v_backoff interval;
begin
  select * into v_row from public.notification_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;

  if p_retryable and v_row.attempt_count < v_row.max_attempts then
    v_backoff := case v_row.attempt_count
      when 1 then interval '30 seconds'
      when 2 then interval '2 minutes'
      when 3 then interval '10 minutes'
      when 4 then interval '30 minutes'
      when 5 then interval '2 hours'
      when 6 then interval '6 hours'
      else interval '24 hours'
    end;
    v_next := timezone('utc', now()) + v_backoff;
    v_status := 'failed';
  else
    v_next := timezone('utc', now());
    v_status := 'dead';
  end if;

  update public.notification_deliveries
  set status = v_status,
      last_error = left(coalesce(p_error, 'error'), 1000),
      next_attempt_at = v_next,
      lease_owner = null,
      lease_expires_at = null
  where id = p_delivery_id;

  insert into public.notification_delivery_attempts (
    delivery_id, attempt_number, outcome, error
  ) values (
    p_delivery_id, v_row.attempt_count, v_status::text, left(coalesce(p_error, 'error'), 1000)
  );
end;
$$;

create or replace function public.materialize_due_notification_schedules(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sched public.notification_schedules%rowtype;
  v_booking public.bookings%rowtype;
  v_count integer := 0;
  v_payload jsonb;
  v_staff_user uuid;
  v_biz_name text;
  v_email text;
begin
  for v_sched in
    select *
    from public.notification_schedules
    where status = 'scheduled'
      and fire_at <= timezone('utc', now())
    order by fire_at
    for update skip locked
    limit greatest(coalesce(p_limit, 20), 1)
  loop
    select * into v_booking from public.bookings where id = v_sched.booking_id for update;
    if not found
       or v_booking.status is distinct from 'confirmed'
       or v_booking.starts_at <= timezone('utc', now())
       or v_booking.starts_at is distinct from v_sched.source_starts_at
    then
      update public.notification_schedules set status = 'cancelled' where id = v_sched.id;
      continue;
    end if;

    select bm.user_id into v_staff_user
    from public.business_members bm where bm.id = v_booking.staff_membership_id;
    select name into v_biz_name from public.businesses where id = v_booking.business_id;
    v_email := coalesce(
      (select c.email from public.customers c where c.id = v_booking.customer_id),
      v_booking.customer_email
    );

    v_payload := jsonb_build_object(
      'title', 'Appointment reminder',
      'body', 'Reminder: appointment in 24 hours',
      'href', '/workspace/' || v_booking.business_id::text || '?tab=bookings',
      'businessName', v_biz_name,
      'bookingId', v_booking.id,
      'referenceCode', v_booking.reference_code,
      'customerName', v_booking.customer_name,
      'customerEmail', v_email,
      'startsAt', v_booking.starts_at,
      'endsAt', v_booking.ends_at,
      'timezone', v_booking.timezone,
      'locationName', v_booking.location_name,
      'staffDisplayName', v_booking.staff_display_name,
      'staffUserId', v_staff_user
    );

    perform public.emit_notification_event(
      v_booking.business_id,
      'booking.reminder.24h',
      'booking',
      v_booking.id,
      v_sched.idempotency_key,
      v_payload,
      null
    );

    update public.notification_schedules set status = 'materialized' where id = v_sched.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Grants: worker only
revoke all on function public.release_expired_delivery_leases() from public;
revoke all on function public.release_expired_delivery_leases() from anon;
revoke all on function public.release_expired_delivery_leases() from authenticated;
grant execute on function public.release_expired_delivery_leases() to fadezy_notify_worker;

revoke all on function public.claim_notification_deliveries(integer, text) from public;
revoke all on function public.claim_notification_deliveries(integer, text) from anon;
revoke all on function public.claim_notification_deliveries(integer, text) from authenticated;
grant execute on function public.claim_notification_deliveries(integer, text) to fadezy_notify_worker;

revoke all on function public.complete_notification_delivery(uuid, text) from public;
revoke all on function public.complete_notification_delivery(uuid, text) from anon;
revoke all on function public.complete_notification_delivery(uuid, text) from authenticated;
grant execute on function public.complete_notification_delivery(uuid, text) to fadezy_notify_worker;

revoke all on function public.fail_notification_delivery(uuid, text, boolean) from public;
revoke all on function public.fail_notification_delivery(uuid, text, boolean) from anon;
revoke all on function public.fail_notification_delivery(uuid, text, boolean) from authenticated;
grant execute on function public.fail_notification_delivery(uuid, text, boolean) to fadezy_notify_worker;

revoke all on function public.materialize_due_notification_schedules(integer) from public;
revoke all on function public.materialize_due_notification_schedules(integer) from anon;
revoke all on function public.materialize_due_notification_schedules(integer) from authenticated;
grant execute on function public.materialize_due_notification_schedules(integer) to fadezy_notify_worker;
