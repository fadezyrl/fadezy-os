-- Phase 07 privilege remediation: SECURITY DEFINER booking RPCs.
-- Owner after apply: migration role (typically postgres). Functions run as owner (bypass RLS internally).
-- Callers: authenticated (workspace) / anon+authenticated (guest). No table grants to anon.

-- ---------------------------------------------------------------------------
-- Internal helper: assert active membership + booking manage permission for location
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_manage_booking_location(
  p_business_id uuid,
  p_location_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_membership_id uuid;
  v_role text;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select bm.id, bm.role::text
  into v_membership_id, v_role
  from public.business_members bm
  where bm.business_id = p_business_id
    and bm.user_id = v_user
    and bm.membership_status = 'active'
    and bm.deactivated_at is null;

  if v_membership_id is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_role in ('owner', 'manager') then
    return v_membership_id;
  end if;

  if v_role = 'staff'
     and exists (
       select 1
       from public.staff_location_assignments sla
       where sla.membership_id = v_membership_id
         and sla.location_id = p_location_id
     )
  then
    return v_membership_id;
  end if;

  raise exception 'FORBIDDEN' using errcode = '42501';
end;
$$;

revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from public;
revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from anon;
revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from authenticated;
-- Internal helper; not granted to anon/authenticated (only called from other definer functions).

-- ---------------------------------------------------------------------------
-- Workspace create booking
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace_booking(
  p_business_id uuid,
  p_location_id uuid,
  p_staff_membership_id uuid,
  p_service_id uuid,
  p_addon_ids uuid[],
  p_starts_at timestamptz,
  p_customer_id uuid,
  p_customer_full_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_notes text,
  p_notes text,
  p_idempotency_key text,
  p_idempotency_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_actor_membership uuid;
  v_location public.business_locations%rowtype;
  v_service public.services%rowtype;
  v_member public.business_members%rowtype;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_email text;
  v_customer_phone text;
  v_staff_name text;
  v_price_minor bigint;
  v_addon_duration integer := 0;
  v_addon_total bigint := 0;
  v_appt_minutes integer;
  v_ends_at timestamptz;
  v_busy_starts timestamptz;
  v_busy_ends timestamptz;
  v_booking_id uuid;
  v_reference text;
  v_existing record;
  v_addon record;
  v_order integer := 0;
  v_addons uuid[] := coalesce(p_addon_ids, '{}'::uuid[]);
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  v_actor_membership := public.assert_can_manage_booking_location(p_business_id, p_location_id);

  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.bookings b
  where b.business_id = p_business_id and b.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.idempotency_payload_hash is distinct from p_idempotency_payload_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return to_jsonb(v_existing);
  end if;

  select * into v_location
  from public.business_locations
  where id = p_location_id and business_id = p_business_id;
  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and business_id = p_business_id;
  if not found or v_service.archived_at is not null or v_service.is_active is not true then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_member
  from public.business_members
  where id = p_staff_membership_id;
  if not found
     or v_member.business_id is distinct from p_business_id
     or v_member.membership_status is distinct from 'active'
     or v_member.deactivated_at is not null
  then
    raise exception 'STAFF_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.staff_location_assignments
    where membership_id = p_staff_membership_id and location_id = p_location_id
  ) then
    raise exception 'STAFF_LOCATION_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.staff_service_assignments
    where membership_id = p_staff_membership_id and service_id = p_service_id
  ) then
    raise exception 'STAFF_SERVICE_INVALID' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.service_location_settings sls
    where sls.service_id = p_service_id
      and sls.location_id = p_location_id
      and sls.is_available is false
  ) then
    raise exception 'SERVICE_LOCATION_UNAVAILABLE' using errcode = '22023';
  end if;

  select coalesce(
    (
      select sls.price_minor
      from public.service_location_settings sls
      where sls.service_id = p_service_id and sls.location_id = p_location_id
    ),
    v_service.price_minor
  )
  into v_price_minor;

  if coalesce(array_length(v_addons, 1), 0) > 0 then
    if (
      select count(*)::int
      from public.service_addons a
      join public.service_addon_links l on l.addon_id = a.id
      where a.business_id = p_business_id
        and a.id = any(v_addons)
        and l.service_id = p_service_id
        and a.archived_at is null
        and a.is_active = true
    ) is distinct from coalesce(array_length(v_addons, 1), 0) then
      raise exception 'ADDON_INVALID' using errcode = '22023';
    end if;

    select coalesce(sum(a.duration_minutes), 0)::int, coalesce(sum(a.price_minor), 0)::bigint
    into v_addon_duration, v_addon_total
    from public.service_addons a
    where a.id = any(v_addons);
  end if;

  if p_customer_id is not null then
    select c.id, c.full_name, c.email, c.phone
    into v_customer_id, v_customer_name, v_customer_email, v_customer_phone
    from public.customers c
    where c.id = p_customer_id and c.business_id = p_business_id;
    if v_customer_id is null then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    if p_customer_full_name is null or char_length(trim(p_customer_full_name)) < 1 then
      raise exception 'CUSTOMER_REQUIRED' using errcode = '22023';
    end if;
    insert into public.customers (business_id, full_name, email, phone, notes)
    values (
      p_business_id,
      trim(p_customer_full_name),
      nullif(trim(p_customer_email), ''),
      nullif(trim(p_customer_phone), ''),
      nullif(trim(p_customer_notes), '')
    )
    returning id, full_name, email, phone
    into v_customer_id, v_customer_name, v_customer_email, v_customer_phone;
  end if;

  select coalesce(sp.display_name, 'Staff') into v_staff_name
  from public.staff_profiles sp
  where sp.membership_id = p_staff_membership_id;

  v_appt_minutes := v_service.duration_minutes
    + coalesce(v_service.processing_minutes, 0)
    + v_addon_duration;
  v_ends_at := p_starts_at + make_interval(mins => v_appt_minutes);
  v_busy_starts := p_starts_at - make_interval(mins => coalesce(v_service.buffer_before_minutes, 0));
  v_busy_ends := v_ends_at + make_interval(mins => coalesce(v_service.buffer_after_minutes, 0));

  v_reference := public.generate_booking_reference(p_business_id);
  v_booking_id := gen_random_uuid();

  begin
    insert into public.bookings (
      id, business_id, location_id, customer_id, staff_membership_id, status, channel,
      starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
      buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
      customer_name, customer_email, customer_phone, location_name, staff_display_name,
      reference_code, idempotency_key, idempotency_payload_hash, notes, created_by_user_id
    ) values (
      v_booking_id, p_business_id, p_location_id, v_customer_id, p_staff_membership_id,
      'confirmed', 'workspace',
      p_starts_at, v_ends_at, v_busy_starts, v_busy_ends, v_location.timezone,
      coalesce(v_service.buffer_before_minutes, 0), coalesce(v_service.buffer_after_minutes, 0),
      v_service.currency, v_price_minor + v_addon_total,
      v_customer_name, v_customer_email, v_customer_phone, v_location.name, coalesce(v_staff_name, 'Staff'),
      v_reference, p_idempotency_key, p_idempotency_payload_hash, nullif(trim(p_notes), ''), v_user
    );
  exception
    when exclusion_violation then
      raise exception 'BOOKING_CONFLICT' using errcode = '23P01';
    when unique_violation then
      select * into v_existing
      from public.bookings b
      where b.business_id = p_business_id and b.idempotency_key = p_idempotency_key;
      if found and v_existing.idempotency_payload_hash = p_idempotency_payload_hash then
        return to_jsonb(v_existing);
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end;

  insert into public.booking_services (
    booking_id, business_id, service_id, service_name, duration_minutes, processing_minutes,
    price_minor, currency, sort_order
  ) values (
    v_booking_id, p_business_id, v_service.id, v_service.name, v_service.duration_minutes,
    coalesce(v_service.processing_minutes, 0), v_price_minor, v_service.currency, 0
  );

  for v_addon in
    select a.*
    from public.service_addons a
    where a.id = any(v_addons)
    order by a.name
  loop
    insert into public.booking_addons (
      booking_id, business_id, addon_id, addon_name, duration_minutes, price_minor, currency, sort_order
    ) values (
      v_booking_id, p_business_id, v_addon.id, v_addon.name, v_addon.duration_minutes,
      v_addon.price_minor, v_addon.currency, v_order
    );
    v_order := v_order + 1;
  end loop;

  insert into public.booking_status_events (
    booking_id, business_id, from_status, to_status, actor_user_id, note
  ) values (
    v_booking_id, p_business_id, null, 'confirmed', v_user, null
  );

  return (
    select to_jsonb(b.*)
    from public.bookings b
    where b.id = v_booking_id
  );
end;
$$;

revoke all on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) from public;
revoke all on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) from anon;
grant execute on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Workspace reschedule
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_booking_times(
  p_booking_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row public.bookings%rowtype;
  v_service public.booking_services%rowtype;
  v_addon_duration integer := 0;
  v_appt_minutes integer;
  v_ends_at timestamptz;
  v_busy_starts timestamptz;
  v_busy_ends timestamptz;
  v_prev_starts timestamptz;
  v_prev_ends timestamptz;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_row from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public.assert_can_manage_booking_location(v_row.business_id, v_row.location_id);

  if v_row.status is distinct from 'confirmed' then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = '22023';
  end if;

  select * into v_service
  from public.booking_services
  where booking_id = p_booking_id
  order by sort_order
  limit 1;
  if not found then
    raise exception 'SERVICE_LINE_MISSING' using errcode = 'P0001';
  end if;

  select coalesce(sum(duration_minutes), 0)::int into v_addon_duration
  from public.booking_addons
  where booking_id = p_booking_id;

  v_appt_minutes := v_service.duration_minutes + v_service.processing_minutes + v_addon_duration;
  v_ends_at := p_starts_at + make_interval(mins => v_appt_minutes);
  v_busy_starts := p_starts_at - make_interval(mins => v_row.buffer_before_minutes);
  v_busy_ends := v_ends_at + make_interval(mins => v_row.buffer_after_minutes);
  v_prev_starts := v_row.starts_at;
  v_prev_ends := v_row.ends_at;

  begin
    update public.bookings
    set starts_at = p_starts_at,
        ends_at = v_ends_at,
        busy_starts_at = v_busy_starts,
        busy_ends_at = v_busy_ends
    where id = p_booking_id
      and status = 'confirmed'
    returning * into v_row;
  exception
    when exclusion_violation then
      raise exception 'BOOKING_CONFLICT' using errcode = '23P01';
  end;

  insert into public.booking_status_events (
    booking_id, business_id, from_status, to_status, actor_user_id, note,
    previous_starts_at, previous_ends_at
  ) values (
    v_row.id, v_row.business_id, 'confirmed', 'confirmed', v_user, 'rescheduled',
    v_prev_starts, v_prev_ends
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.reschedule_booking_times(uuid, timestamptz) from public;
revoke all on function public.reschedule_booking_times(uuid, timestamptz) from anon;
grant execute on function public.reschedule_booking_times(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Guest slot context (no customer PII)
-- ---------------------------------------------------------------------------
create or replace function public.guest_get_booking_slot_context(
  p_business_slug text,
  p_location_id uuid,
  p_staff_membership_id uuid,
  p_service_id uuid,
  p_addon_ids uuid[],
  p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_location public.business_locations%rowtype;
  v_service public.services%rowtype;
  v_member public.business_members%rowtype;
  v_hours_mode text;
  v_weekday integer;
  v_intervals jsonb := '[]'::jsonb;
  v_location_windows jsonb := '[]'::jsonb;
  v_staff_windows jsonb := '[]'::jsonb;
  v_staff_breaks jsonb := '[]'::jsonb;
  v_time_off jsonb := '[]'::jsonb;
  v_busy jsonb := '[]'::jsonb;
  v_notes text[] := '{}';
  v_location_closed boolean := false;
  v_location_source text := 'none';
  v_exception record;
  v_schedule record;
  v_price_minor bigint;
  v_addon_duration integer := 0;
  v_addons uuid[] := coalesce(p_addon_ids, '{}'::uuid[]);
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  select b.id into v_business_id
  from public.businesses b
  where lower(b.slug) = lower(trim(p_business_slug))
  limit 1;
  if v_business_id is null then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_location
  from public.business_locations
  where id = p_location_id and business_id = v_business_id;
  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and business_id = v_business_id;
  if not found or v_service.archived_at is not null or v_service.is_active is not true then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_service.is_bookable_online is not true then
    raise exception 'SERVICE_NOT_ONLINE' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.service_location_settings sls
    where sls.service_id = p_service_id
      and sls.location_id = p_location_id
      and sls.is_available is false
  ) then
    raise exception 'SERVICE_LOCATION_UNAVAILABLE' using errcode = '22023';
  end if;

  select coalesce(
    (
      select sls.price_minor
      from public.service_location_settings sls
      where sls.service_id = p_service_id and sls.location_id = p_location_id
    ),
    v_service.price_minor
  )
  into v_price_minor;

  select * into v_member from public.business_members where id = p_staff_membership_id;
  if not found
     or v_member.business_id is distinct from v_business_id
     or v_member.membership_status is distinct from 'active'
     or v_member.deactivated_at is not null
  then
    raise exception 'STAFF_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.staff_location_assignments
    where membership_id = p_staff_membership_id and location_id = p_location_id
  ) then
    raise exception 'STAFF_LOCATION_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.staff_service_assignments
    where membership_id = p_staff_membership_id and service_id = p_service_id
  ) then
    raise exception 'STAFF_SERVICE_INVALID' using errcode = '22023';
  end if;

  if coalesce(array_length(v_addons, 1), 0) > 0 then
    if (
      select count(*)::int
      from public.service_addons a
      join public.service_addon_links l on l.addon_id = a.id
      where a.business_id = v_business_id
        and a.id = any(v_addons)
        and l.service_id = p_service_id
        and a.archived_at is null
        and a.is_active = true
    ) is distinct from coalesce(array_length(v_addons, 1), 0) then
      raise exception 'ADDON_INVALID' using errcode = '22023';
    end if;
    select coalesce(sum(a.duration_minutes), 0)::int into v_addon_duration
    from public.service_addons a where a.id = any(v_addons);
  end if;

  v_hours_mode := case when v_location.hours_mode = 'custom' then 'custom' else 'inherit' end;
  v_weekday := extract(isodow from p_date at time zone v_location.timezone)::int;

  if v_hours_mode = 'inherit' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'weekday', weekday, 'startMinute', start_minute, 'endMinute', end_minute
    ) order by weekday, sort_order, start_minute), '[]'::jsonb)
    into v_intervals
    from public.business_weekly_hours
    where business_id = v_business_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'weekday', weekday, 'startMinute', start_minute, 'endMinute', end_minute
    ) order by weekday, sort_order, start_minute), '[]'::jsonb)
    into v_intervals
    from public.location_weekly_hours
    where location_id = p_location_id;
  end if;

  select * into v_exception
  from public.schedule_date_exceptions
  where business_id = v_business_id
    and cancelled_at is null
    and exception_date = p_date
    and (location_id = p_location_id or location_id is null)
  order by case when location_id = p_location_id then 0 else 1 end
  limit 1;

  if v_exception.id is not null and v_exception.kind = 'closed' then
    v_location_closed := true;
    v_location_source := 'closed_exception';
    v_notes := array_append(v_notes, 'Location closed by dated exception');
  elsif v_exception.id is not null and v_exception.kind = 'special_hours' then
    v_location_source := 'special_hours';
    v_location_windows := coalesce(v_exception.intervals, '[]'::jsonb);
    v_notes := array_append(v_notes, 'Location using special hours exception');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'startMinute', (item->>'startMinute')::int,
      'endMinute', (item->>'endMinute')::int
    )), '[]'::jsonb)
    into v_location_windows
    from jsonb_array_elements(v_intervals) item
    where (item->>'weekday')::int = v_weekday;
    v_location_source := case when v_hours_mode = 'inherit' then 'inherit_weekly' else 'weekly' end;
    if v_location_windows = '[]'::jsonb then
      v_location_closed := true;
      v_notes := array_append(v_notes, 'No weekly open intervals for this weekday');
    end if;
  end if;

  select * into v_schedule
  from public.staff_weekly_schedules
  where business_id = v_business_id
    and membership_id = p_staff_membership_id
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc
  limit 1;

  if v_schedule.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'startMinute', start_minute, 'endMinute', end_minute
    ) order by sort_order, start_minute), '[]'::jsonb)
    into v_staff_windows
    from public.staff_weekly_intervals
    where schedule_id = v_schedule.id
      and weekday = v_weekday
      and location_id = p_location_id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'startMinute', start_minute, 'endMinute', end_minute
    ) order by sort_order, start_minute), '[]'::jsonb)
    into v_staff_breaks
    from public.staff_weekly_breaks
    where schedule_id = v_schedule.id
      and weekday = v_weekday;
  else
    v_notes := array_append(v_notes, 'No effective staff schedule version for date');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'startsAt', starts_at, 'endsAt', ends_at, 'status', status
  )), '[]'::jsonb)
  into v_time_off
  from public.staff_time_off
  where business_id = v_business_id
    and membership_id = p_staff_membership_id
    and status in ('approved', 'pending')
    and (location_id is null or location_id = p_location_id);

  if exists (
    select 1 from jsonb_array_elements(v_time_off) t where t->>'status' = 'approved'
  ) then
    v_notes := array_append(v_notes, 'Approved time off applied over recurring schedule');
  end if;

  -- Busy occupancy for staff (confirmed only). Window: local date ± 2 days in UTC approx via timestamptz cast.
  v_day_start := (p_date::timestamp at time zone v_location.timezone);
  v_day_end := ((p_date + 2)::timestamp at time zone v_location.timezone);

  select coalesce(jsonb_agg(jsonb_build_object(
    'busyStartsAt', busy_starts_at,
    'busyEndsAt', busy_ends_at,
    'bookingId', id
  )), '[]'::jsonb)
  into v_busy
  from public.bookings
  where staff_membership_id = p_staff_membership_id
    and status = 'confirmed'
    and busy_starts_at < v_day_end
    and busy_ends_at > v_day_start;

  if v_location_closed then
    v_notes := array_append(v_notes, 'Location closure overrides staff availability');
  end if;

  return jsonb_build_object(
    'businessId', v_business_id,
    'locationId', p_location_id,
    'membershipId', p_staff_membership_id,
    'date', p_date,
    'timezone', v_location.timezone,
    'locationClosed', v_location_closed,
    'locationWindows', coalesce(v_location_windows, '[]'::jsonb),
    'locationSource', v_location_source,
    'staffWindows', coalesce(v_staff_windows, '[]'::jsonb),
    'staffBreaks', coalesce(v_staff_breaks, '[]'::jsonb),
    'timeOffBlocks', coalesce(v_time_off, '[]'::jsonb),
    'busyRanges', coalesce(v_busy, '[]'::jsonb),
    'notes', to_jsonb(v_notes),
    'timing', jsonb_build_object(
      'durationMinutes', v_service.duration_minutes,
      'processingMinutes', coalesce(v_service.processing_minutes, 0),
      'bufferBeforeMinutes', coalesce(v_service.buffer_before_minutes, 0),
      'bufferAfterMinutes', coalesce(v_service.buffer_after_minutes, 0),
      'addonDurationMinutes', v_addon_duration,
      'priceMinor', v_price_minor,
      'currency', v_service.currency,
      'serviceName', v_service.name,
      'serviceId', v_service.id
    )
  );
end;
$$;

revoke all on function public.guest_get_booking_slot_context(text, uuid, uuid, uuid, uuid[], date) from public;
grant execute on function public.guest_get_booking_slot_context(text, uuid, uuid, uuid, uuid[], date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guest create booking (no customer id accepted)
-- ---------------------------------------------------------------------------
create or replace function public.create_guest_booking(
  p_business_slug text,
  p_location_id uuid,
  p_staff_membership_id uuid,
  p_service_id uuid,
  p_addon_ids uuid[],
  p_starts_at timestamptz,
  p_customer_full_name text,
  p_customer_email text,
  p_customer_phone text,
  p_notes text,
  p_idempotency_key text,
  p_idempotency_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_location public.business_locations%rowtype;
  v_service public.services%rowtype;
  v_member public.business_members%rowtype;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_email text;
  v_customer_phone text;
  v_staff_name text;
  v_price_minor bigint;
  v_addon_duration integer := 0;
  v_addon_total bigint := 0;
  v_appt_minutes integer;
  v_ends_at timestamptz;
  v_busy_starts timestamptz;
  v_busy_ends timestamptz;
  v_booking_id uuid;
  v_reference text;
  v_existing record;
  v_addon record;
  v_order integer := 0;
  v_addons uuid[] := coalesce(p_addon_ids, '{}'::uuid[]);
  v_public jsonb;
begin
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_customer_full_name is null or char_length(trim(p_customer_full_name)) < 1 then
    raise exception 'CUSTOMER_REQUIRED' using errcode = '22023';
  end if;

  select b.id into v_business_id
  from public.businesses b
  where lower(b.slug) = lower(trim(p_business_slug))
  limit 1;
  if v_business_id is null then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.bookings b
  where b.business_id = v_business_id and b.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.idempotency_payload_hash is distinct from p_idempotency_payload_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    -- Public-safe subset only
    return jsonb_build_object(
      'id', v_existing.id,
      'businessId', v_existing.business_id,
      'referenceCode', v_existing.reference_code,
      'status', v_existing.status,
      'channel', v_existing.channel,
      'startsAt', v_existing.starts_at,
      'endsAt', v_existing.ends_at,
      'timezone', v_existing.timezone,
      'locationName', v_existing.location_name,
      'staffDisplayName', v_existing.staff_display_name,
      'customerName', v_existing.customer_name,
      'totalPriceMinor', v_existing.total_price_minor,
      'currency', v_existing.currency
    );
  end if;

  select * into v_location
  from public.business_locations
  where id = p_location_id and business_id = v_business_id;
  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and business_id = v_business_id;
  if not found or v_service.archived_at is not null or v_service.is_active is not true then
    raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_service.is_bookable_online is not true then
    raise exception 'SERVICE_NOT_ONLINE' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.service_location_settings sls
    where sls.service_id = p_service_id and sls.location_id = p_location_id and sls.is_available is false
  ) then
    raise exception 'SERVICE_LOCATION_UNAVAILABLE' using errcode = '22023';
  end if;

  select coalesce(
    (
      select sls.price_minor
      from public.service_location_settings sls
      where sls.service_id = p_service_id and sls.location_id = p_location_id
    ),
    v_service.price_minor
  )
  into v_price_minor;

  select * into v_member from public.business_members where id = p_staff_membership_id;
  if not found
     or v_member.business_id is distinct from v_business_id
     or v_member.membership_status is distinct from 'active'
     or v_member.deactivated_at is not null
  then
    raise exception 'STAFF_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.staff_location_assignments
    where membership_id = p_staff_membership_id and location_id = p_location_id
  ) then
    raise exception 'STAFF_LOCATION_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.staff_service_assignments
    where membership_id = p_staff_membership_id and service_id = p_service_id
  ) then
    raise exception 'STAFF_SERVICE_INVALID' using errcode = '22023';
  end if;

  if coalesce(array_length(v_addons, 1), 0) > 0 then
    if (
      select count(*)::int
      from public.service_addons a
      join public.service_addon_links l on l.addon_id = a.id
      where a.business_id = v_business_id
        and a.id = any(v_addons)
        and l.service_id = p_service_id
        and a.archived_at is null
        and a.is_active = true
    ) is distinct from coalesce(array_length(v_addons, 1), 0) then
      raise exception 'ADDON_INVALID' using errcode = '22023';
    end if;
    select coalesce(sum(a.duration_minutes), 0)::int, coalesce(sum(a.price_minor), 0)::bigint
    into v_addon_duration, v_addon_total
    from public.service_addons a where a.id = any(v_addons);
  end if;

  insert into public.customers (business_id, full_name, email, phone)
  values (
    v_business_id,
    trim(p_customer_full_name),
    nullif(trim(p_customer_email), ''),
    nullif(trim(p_customer_phone), '')
  )
  returning id, full_name, email, phone
  into v_customer_id, v_customer_name, v_customer_email, v_customer_phone;

  select coalesce(sp.display_name, 'Staff') into v_staff_name
  from public.staff_profiles sp where sp.membership_id = p_staff_membership_id;

  v_appt_minutes := v_service.duration_minutes
    + coalesce(v_service.processing_minutes, 0)
    + v_addon_duration;
  v_ends_at := p_starts_at + make_interval(mins => v_appt_minutes);
  v_busy_starts := p_starts_at - make_interval(mins => coalesce(v_service.buffer_before_minutes, 0));
  v_busy_ends := v_ends_at + make_interval(mins => coalesce(v_service.buffer_after_minutes, 0));
  v_reference := public.generate_booking_reference(v_business_id);
  v_booking_id := gen_random_uuid();

  begin
    insert into public.bookings (
      id, business_id, location_id, customer_id, staff_membership_id, status, channel,
      starts_at, ends_at, busy_starts_at, busy_ends_at, timezone,
      buffer_before_minutes, buffer_after_minutes, currency, total_price_minor,
      customer_name, customer_email, customer_phone, location_name, staff_display_name,
      reference_code, idempotency_key, idempotency_payload_hash, notes, created_by_user_id
    ) values (
      v_booking_id, v_business_id, p_location_id, v_customer_id, p_staff_membership_id,
      'confirmed', 'online',
      p_starts_at, v_ends_at, v_busy_starts, v_busy_ends, v_location.timezone,
      coalesce(v_service.buffer_before_minutes, 0), coalesce(v_service.buffer_after_minutes, 0),
      v_service.currency, v_price_minor + v_addon_total,
      v_customer_name, v_customer_email, v_customer_phone, v_location.name, coalesce(v_staff_name, 'Staff'),
      v_reference, p_idempotency_key, p_idempotency_payload_hash, nullif(trim(p_notes), ''), null
    );
  exception
    when exclusion_violation then
      raise exception 'BOOKING_CONFLICT' using errcode = '23P01';
    when unique_violation then
      select * into v_existing
      from public.bookings b
      where b.business_id = v_business_id and b.idempotency_key = p_idempotency_key;
      if found and v_existing.idempotency_payload_hash = p_idempotency_payload_hash then
        return jsonb_build_object(
          'id', v_existing.id,
          'businessId', v_existing.business_id,
          'referenceCode', v_existing.reference_code,
          'status', v_existing.status,
          'channel', v_existing.channel,
          'startsAt', v_existing.starts_at,
          'endsAt', v_existing.ends_at,
          'timezone', v_existing.timezone,
          'locationName', v_existing.location_name,
          'staffDisplayName', v_existing.staff_display_name,
          'customerName', v_existing.customer_name,
          'totalPriceMinor', v_existing.total_price_minor,
          'currency', v_existing.currency
        );
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end;

  insert into public.booking_services (
    booking_id, business_id, service_id, service_name, duration_minutes, processing_minutes,
    price_minor, currency, sort_order
  ) values (
    v_booking_id, v_business_id, v_service.id, v_service.name, v_service.duration_minutes,
    coalesce(v_service.processing_minutes, 0), v_price_minor, v_service.currency, 0
  );

  for v_addon in
    select a.* from public.service_addons a where a.id = any(v_addons) order by a.name
  loop
    insert into public.booking_addons (
      booking_id, business_id, addon_id, addon_name, duration_minutes, price_minor, currency, sort_order
    ) values (
      v_booking_id, v_business_id, v_addon.id, v_addon.name, v_addon.duration_minutes,
      v_addon.price_minor, v_addon.currency, v_order
    );
    v_order := v_order + 1;
  end loop;

  insert into public.booking_status_events (
    booking_id, business_id, from_status, to_status, actor_user_id, note
  ) values (
    v_booking_id, v_business_id, null, 'confirmed', null, null
  );

  select jsonb_build_object(
    'id', b.id,
    'businessId', b.business_id,
    'referenceCode', b.reference_code,
    'status', b.status,
    'channel', b.channel,
    'startsAt', b.starts_at,
    'endsAt', b.ends_at,
    'timezone', b.timezone,
    'locationName', b.location_name,
    'staffDisplayName', b.staff_display_name,
    'customerName', b.customer_name,
    'totalPriceMinor', b.total_price_minor,
    'currency', b.currency
  )
  into v_public
  from public.bookings b
  where b.id = v_booking_id;

  return v_public;
end;
$$;

revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from public;
grant execute on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Final grant hygiene (Supabase CREATE FUNCTION auto-grants anon/authenticated/
-- service_role; revoke after create so only intended callers retain EXECUTE)
-- ---------------------------------------------------------------------------
revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from public;
revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from anon;
revoke all on function public.assert_can_manage_booking_location(uuid, uuid) from authenticated;

revoke all on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) from public;
revoke all on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) from anon;
grant execute on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) to authenticated;

revoke all on function public.reschedule_booking_times(uuid, timestamptz) from public;
revoke all on function public.reschedule_booking_times(uuid, timestamptz) from anon;
grant execute on function public.reschedule_booking_times(uuid, timestamptz) to authenticated;

revoke all on function public.guest_get_booking_slot_context(text, uuid, uuid, uuid, uuid[], date) from public;
grant execute on function public.guest_get_booking_slot_context(text, uuid, uuid, uuid, uuid[], date) to anon, authenticated;

revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from public;
grant execute on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) to anon, authenticated;

-- No table grants to anon (already revoked in prior migration). Guest path is RPC-only.
