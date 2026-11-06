-- Phase 10 v1: emit helpers, recipient resolution, reminder cancel/schedule

create or replace function public.notification_pref_enabled(
  p_business_id uuid,
  p_user_id uuid,
  p_event_type text,
  p_channel public.notification_channel,
  p_default boolean
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select enabled
      from public.notification_preferences
      where business_id = p_business_id
        and user_id = p_user_id
        and event_type = p_event_type
        and channel = p_channel
      limit 1
    ),
    p_default
  );
$$;

revoke all on function public.notification_pref_enabled(uuid, uuid, text, public.notification_channel, boolean) from public;
revoke all on function public.notification_pref_enabled(uuid, uuid, text, public.notification_channel, boolean) from anon;
revoke all on function public.notification_pref_enabled(uuid, uuid, text, public.notification_channel, boolean) from authenticated;

create or replace function public.cancel_booking_reminder_state(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serialize materialize vs mutation on this booking's schedules
  perform 1
  from public.notification_schedules
  where booking_id = p_booking_id
  for update;

  update public.notification_schedules
  set status = 'cancelled'
  where booking_id = p_booking_id
    and status = 'scheduled';

  update public.notification_deliveries d
  set status = 'cancelled',
      skip_reason = coalesce(d.skip_reason, 'booking_state_changed')
  from public.notification_events e
  where d.event_id = e.id
    and e.entity_type = 'booking'
    and e.entity_id = p_booking_id
    and e.event_type = 'booking.reminder.24h'
    and d.status in ('pending', 'failed');
end;
$$;

revoke all on function public.cancel_booking_reminder_state(uuid) from public;
revoke all on function public.cancel_booking_reminder_state(uuid) from anon;
revoke all on function public.cancel_booking_reminder_state(uuid) from authenticated;

create or replace function public.schedule_booking_reminder_24h(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_key text;
  v_fire timestamptz;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found or v_booking.status is distinct from 'confirmed' then
    return;
  end if;

  perform public.cancel_booking_reminder_state(p_booking_id);

  v_fire := v_booking.starts_at - interval '24 hours';
  v_key := 'booking.reminder.24h:' || v_booking.id::text || ':' || to_char(v_booking.starts_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  insert into public.notification_schedules (
    business_id, booking_id, event_type, fire_at, timezone, source_starts_at, status, idempotency_key
  ) values (
    v_booking.business_id, v_booking.id, 'booking.reminder.24h', v_fire, v_booking.timezone,
    v_booking.starts_at, 'scheduled', v_key
  )
  on conflict (business_id, idempotency_key) do update
  set status = 'scheduled',
      fire_at = excluded.fire_at,
      timezone = excluded.timezone,
      source_starts_at = excluded.source_starts_at,
      updated_at = timezone('utc', now())
  where public.notification_schedules.status = 'cancelled';
end;
$$;

revoke all on function public.schedule_booking_reminder_24h(uuid) from public;
revoke all on function public.schedule_booking_reminder_24h(uuid) from anon;
revoke all on function public.schedule_booking_reminder_24h(uuid) from authenticated;

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

  -- Customer email (mandatory transactional for booking lifecycle / reminder)
  if p_event_type in (
    'booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.reminder.24h'
  ) then
    v_email := nullif(lower(trim(v_payload->>'customerEmail')), '');
    if v_email is null then
      null; -- no delivery
    else
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

  -- Reminder: customer email only (no staff / owner / manager copies)
  if p_event_type = 'booking.reminder.24h' then
    return v_event_id;
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
      -- skip if same as assigned staff already handled for booking staff copy (still OK to notify managers)
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

  -- Time-off requester decision (mandatory-ish transactional to requester)
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

  -- Time-off requester ack in-app on request
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
