-- Phase 10 remediation:
-- 1) Lease-owner validation on worker delivery RPCs (new signatures)
-- 2) Reminder fan-out: customer email only for booking.reminder.24h
-- 3) Revoke unnecessary service_role EXECUTE on worker RPCs

-- ---------------------------------------------------------------------------
-- Reminder recipient fan-out (emit)
-- ---------------------------------------------------------------------------
create or replace function public.emit_notification_event(
  p_business_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_idempotency_key text,
  p_payload jsonb,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_existing uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_rec record;
  v_email text;
  v_delivery_id uuid;
  v_title text;
  v_body text;
  v_href text;
  v_staff_user uuid;
begin
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 4 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select id into v_existing
  from public.notification_events
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  insert into public.notification_events (
    business_id, event_type, entity_type, entity_id, actor_user_id, idempotency_key, payload
  ) values (
    p_business_id, p_event_type, p_entity_type, p_entity_id, p_actor_user_id, p_idempotency_key, v_payload
  )
  on conflict (business_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id into v_event_id
    from public.notification_events
    where business_id = p_business_id and idempotency_key = p_idempotency_key;
    return v_event_id;
  end if;

  v_title := coalesce(v_payload->>'title', p_event_type);
  v_body := coalesce(v_payload->>'body', p_event_type);
  v_href := v_payload->>'href';

  -- Customer email (booking lifecycle / reminder only)
  if p_event_type in (
    'booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.reminder.24h'
  ) then
    v_email := nullif(lower(trim(v_payload->>'customerEmail')), '');
    if v_email is not null then
      insert into public.notification_deliveries (
        event_id, business_id, channel, template_key, to_email, status
      ) values (
        v_event_id, p_business_id, 'email',
        case p_event_type
          when 'booking.created' then 'booking_created_customer'
          when 'booking.rescheduled' then 'booking_rescheduled_customer'
          when 'booking.cancelled' then 'booking_cancelled_customer'
          else 'booking_reminder_customer'
        end,
        v_email, 'pending'
      )
      on conflict do nothing;
    end if;
  end if;

  -- Reminder: customer email only (no staff / owner / manager copies)
  if p_event_type = 'booking.reminder.24h' then
    return v_event_id;
  end if;

  -- Assigned staff in-app (booking) + optional email (default OFF)
  if p_event_type in (
    'booking.created', 'booking.rescheduled', 'booking.cancelled',
    'booking.completed', 'booking.no_show'
  ) and (v_payload ? 'staffUserId') then
    v_staff_user := nullif(v_payload->>'staffUserId', '')::uuid;
    if v_staff_user is not null then
      if public.notification_pref_enabled(p_business_id, v_staff_user, p_event_type, 'in_app', true) then
        insert into public.notification_deliveries (
          event_id, business_id, channel, template_key, recipient_user_id, status
        ) values (
          v_event_id, p_business_id, 'in_app', 'booking_staff_in_app', v_staff_user, 'pending'
        )
        on conflict do nothing
        returning id into v_delivery_id;
        if v_delivery_id is not null then
          insert into public.in_app_notifications (
            delivery_id, business_id, user_id, title, body, href
          ) values (
            v_delivery_id, p_business_id, v_staff_user, v_title, v_body, v_href
          );
          update public.notification_deliveries
          set status = 'sent', sent_at = timezone('utc', now())
          where id = v_delivery_id;
        end if;
      end if;

      if public.notification_pref_enabled(p_business_id, v_staff_user, p_event_type, 'email', false) then
        select lower(u.email) into v_email from auth.users u where u.id = v_staff_user;
        if v_email is not null then
          insert into public.notification_deliveries (
            event_id, business_id, channel, template_key, recipient_user_id, to_email, status
          ) values (
            v_event_id, p_business_id, 'email', 'booking_staff_email', v_staff_user, v_email, 'pending'
          )
          on conflict do nothing;
        end if;
      end if;
    end if;
  end if;

  -- Owners / managers in-app (default ON) + email (default OFF)
  -- Excludes booking.reminder.24h (handled above)
  if p_event_type like 'booking.%' or p_event_type like 'time_off.%' or p_event_type like 'sale.%' then
    for v_rec in
      select bm.user_id, bm.role::text as role
      from public.business_members bm
      where bm.business_id = p_business_id
        and bm.membership_status = 'active'
        and bm.deactivated_at is null
        and bm.role in ('owner', 'manager')
    loop
      if public.notification_pref_enabled(p_business_id, v_rec.user_id, p_event_type, 'in_app', true) then
        insert into public.notification_deliveries (
          event_id, business_id, channel, template_key, recipient_user_id, status
        ) values (
          v_event_id, p_business_id, 'in_app', p_event_type || '_in_app', v_rec.user_id, 'pending'
        )
        on conflict do nothing
        returning id into v_delivery_id;
        if v_delivery_id is not null then
          insert into public.in_app_notifications (
            delivery_id, business_id, user_id, title, body, href
          ) values (
            v_delivery_id, p_business_id, v_rec.user_id, v_title, v_body, v_href
          );
          update public.notification_deliveries
          set status = 'sent', sent_at = timezone('utc', now())
          where id = v_delivery_id;
        end if;
      end if;

      if public.notification_pref_enabled(p_business_id, v_rec.user_id, p_event_type, 'email', false) then
        select lower(u.email) into v_email from auth.users u where u.id = v_rec.user_id;
        if v_email is not null then
          insert into public.notification_deliveries (
            event_id, business_id, channel, template_key, recipient_user_id, to_email, status
          ) values (
            v_event_id, p_business_id, 'email', p_event_type || '_email', v_rec.user_id, v_email, 'pending'
          )
          on conflict do nothing;
        end if;
      end if;
    end loop;
  end if;

  if p_event_type in ('time_off.approved', 'time_off.rejected') and (v_payload ? 'requesterUserId') then
    v_staff_user := nullif(v_payload->>'requesterUserId', '')::uuid;
    if v_staff_user is not null then
      insert into public.notification_deliveries (
        event_id, business_id, channel, template_key, recipient_user_id, status
      ) values (
        v_event_id, p_business_id, 'in_app', 'time_off_decision_in_app', v_staff_user, 'pending'
      )
      on conflict do nothing
      returning id into v_delivery_id;
      if v_delivery_id is not null then
        insert into public.in_app_notifications (
          delivery_id, business_id, user_id, title, body, href
        ) values (
          v_delivery_id, p_business_id, v_staff_user, v_title, v_body, v_href
        );
        update public.notification_deliveries
        set status = 'sent', sent_at = timezone('utc', now())
        where id = v_delivery_id;
      end if;

      select lower(u.email) into v_email from auth.users u where u.id = v_staff_user;
      if v_email is not null then
        insert into public.notification_deliveries (
          event_id, business_id, channel, template_key, recipient_user_id, to_email, status
        ) values (
          v_event_id, p_business_id, 'email', 'time_off_decision_email', v_staff_user, v_email, 'pending'
        )
        on conflict do nothing;
      end if;
    end if;
  end if;

  if p_event_type = 'time_off.requested' and (v_payload ? 'requesterUserId') then
    v_staff_user := nullif(v_payload->>'requesterUserId', '')::uuid;
    if v_staff_user is not null then
      insert into public.notification_deliveries (
        event_id, business_id, channel, template_key, recipient_user_id, status
      ) values (
        v_event_id, p_business_id, 'in_app', 'time_off_requested_ack', v_staff_user, 'pending'
      )
      on conflict do nothing
      returning id into v_delivery_id;
      if v_delivery_id is not null then
        insert into public.in_app_notifications (
          delivery_id, business_id, user_id, title, body, href
        ) values (
          v_delivery_id, p_business_id, v_staff_user, v_title, v_body, v_href
        );
        update public.notification_deliveries
        set status = 'sent', sent_at = timezone('utc', now())
        where id = v_delivery_id;
      end if;
    end if;
  end if;

  return v_event_id;
end;
$$;

revoke all on function public.emit_notification_event(
  uuid, text, text, uuid, text, jsonb, uuid
) from public;
revoke all on function public.emit_notification_event(
  uuid, text, text, uuid, text, jsonb, uuid
) from anon;
revoke all on function public.emit_notification_event(
  uuid, text, text, uuid, text, jsonb, uuid
) from authenticated;

-- ---------------------------------------------------------------------------
-- Shared lease assertion helper (internal; not granted to clients)
-- ---------------------------------------------------------------------------
create or replace function public.assert_notification_delivery_lease(
  p_delivery_id uuid,
  p_worker_id text
)
returns public.notification_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_deliveries%rowtype;
  v_owner text := left(nullif(trim(p_worker_id), ''), 120);
begin
  if v_owner is null then
    raise exception 'DELIVERY_LEASE_INVALID' using errcode = '42501';
  end if;

  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
  for update;

  if not found then
    raise exception 'DELIVERY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_row.status is distinct from 'processing'
     or v_row.lease_owner is distinct from v_owner
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= timezone('utc', now())
  then
    raise exception 'DELIVERY_LEASE_INVALID' using errcode = '42501';
  end if;

  return v_row;
end;
$$;

revoke all on function public.assert_notification_delivery_lease(uuid, text) from public;
revoke all on function public.assert_notification_delivery_lease(uuid, text) from anon;
revoke all on function public.assert_notification_delivery_lease(uuid, text) from authenticated;
revoke all on function public.assert_notification_delivery_lease(uuid, text) from service_role;
-- Not granted to fadezy_notify_worker — only called inside other security definer RPCs

-- Drop old signatures (no worker identity)
drop function if exists public.complete_notification_delivery(uuid, text);
drop function if exists public.fail_notification_delivery(uuid, text, boolean);
drop function if exists public.skip_notification_delivery(uuid, text);
drop function if exists public.worker_get_delivery_payload(uuid);

create or replace function public.complete_notification_delivery(
  p_delivery_id uuid,
  p_provider_message_id text,
  p_worker_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  v_row := public.assert_notification_delivery_lease(p_delivery_id, p_worker_id);

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
  p_retryable boolean,
  p_worker_id text
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
  v_row := public.assert_notification_delivery_lease(p_delivery_id, p_worker_id);

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

create or replace function public.skip_notification_delivery(
  p_delivery_id uuid,
  p_reason text,
  p_worker_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  v_row := public.assert_notification_delivery_lease(p_delivery_id, p_worker_id);

  update public.notification_deliveries
  set status = 'skipped',
      skip_reason = left(coalesce(nullif(trim(p_reason), ''), 'skipped'), 500),
      lease_owner = null,
      lease_expires_at = null,
      last_error = null
  where id = p_delivery_id;

  insert into public.notification_delivery_attempts (
    delivery_id, attempt_number, outcome, error
  ) values (
    p_delivery_id, v_row.attempt_count, 'skipped', left(coalesce(p_reason, 'skipped'), 1000)
  );
end;
$$;

create or replace function public.worker_get_delivery_payload(
  p_delivery_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  perform public.assert_notification_delivery_lease(p_delivery_id, p_worker_id);

  select e.payload into v_payload
  from public.notification_deliveries d
  join public.notification_events e on e.id = d.event_id
  where d.id = p_delivery_id;

  return coalesce(v_payload, '{}'::jsonb);
end;
$$;

-- Grants: worker only (revoke public/anon/authenticated/service_role)
revoke all on function public.complete_notification_delivery(uuid, text, text) from public;
revoke all on function public.complete_notification_delivery(uuid, text, text) from anon;
revoke all on function public.complete_notification_delivery(uuid, text, text) from authenticated;
revoke all on function public.complete_notification_delivery(uuid, text, text) from service_role;
grant execute on function public.complete_notification_delivery(uuid, text, text) to fadezy_notify_worker;

revoke all on function public.fail_notification_delivery(uuid, text, boolean, text) from public;
revoke all on function public.fail_notification_delivery(uuid, text, boolean, text) from anon;
revoke all on function public.fail_notification_delivery(uuid, text, boolean, text) from authenticated;
revoke all on function public.fail_notification_delivery(uuid, text, boolean, text) from service_role;
grant execute on function public.fail_notification_delivery(uuid, text, boolean, text) to fadezy_notify_worker;

revoke all on function public.skip_notification_delivery(uuid, text, text) from public;
revoke all on function public.skip_notification_delivery(uuid, text, text) from anon;
revoke all on function public.skip_notification_delivery(uuid, text, text) from authenticated;
revoke all on function public.skip_notification_delivery(uuid, text, text) from service_role;
grant execute on function public.skip_notification_delivery(uuid, text, text) to fadezy_notify_worker;

revoke all on function public.worker_get_delivery_payload(uuid, text) from public;
revoke all on function public.worker_get_delivery_payload(uuid, text) from anon;
revoke all on function public.worker_get_delivery_payload(uuid, text) from authenticated;
revoke all on function public.worker_get_delivery_payload(uuid, text) from service_role;
grant execute on function public.worker_get_delivery_payload(uuid, text) to fadezy_notify_worker;

-- Tighten remaining worker RPCs: drop service_role where present
revoke all on function public.release_expired_delivery_leases() from service_role;
revoke all on function public.claim_notification_deliveries(integer, text) from service_role;
revoke all on function public.materialize_due_notification_schedules(integer) from service_role;
