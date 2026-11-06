-- Phase 08: Customer CRM foundations
-- 1) Reject archived customers in create_workspace_booking (authoritative)
-- 2) Visit-history index on bookings (customer_id, starts_at DESC, id DESC)
-- Preserves create_workspace_booking signature, grants, search_path, and SECURITY DEFINER behavior.

create index if not exists bookings_customer_starts_idx
  on public.bookings (customer_id, starts_at desc, id desc);

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
  v_customer_archived_at timestamptz;
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
    select c.id, c.full_name, c.email, c.phone, c.archived_at
    into v_customer_id, v_customer_name, v_customer_email, v_customer_phone, v_customer_archived_at
    from public.customers c
    where c.id = p_customer_id and c.business_id = p_business_id;
    if v_customer_id is null then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_customer_archived_at is not null then
      raise exception 'CUSTOMER_ARCHIVED' using errcode = '22023';
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
