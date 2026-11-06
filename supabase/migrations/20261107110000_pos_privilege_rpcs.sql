-- Phase 09: POS SECURITY DEFINER RPCs (authoritative writes)

create or replace function public.assert_can_manage_pos_location(
  p_business_id uuid,
  p_location_id uuid
)
returns table (membership_id uuid, role text)
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
    membership_id := v_membership_id;
    role := v_role;
    return next;
    return;
  end if;

  if v_role = 'staff'
     and exists (
       select 1 from public.staff_location_assignments sla
       where sla.membership_id = v_membership_id and sla.location_id = p_location_id
     )
  then
    membership_id := v_membership_id;
    role := v_role;
    return next;
    return;
  end if;

  raise exception 'FORBIDDEN' using errcode = '42501';
end;
$$;

revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from public;
revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from anon;
revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from authenticated;

create or replace function public.assert_pos_manager(p_business_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_membership_id uuid;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select bm.id into v_membership_id
  from public.business_members bm
  where bm.business_id = p_business_id
    and bm.user_id = v_user
    and bm.membership_status = 'active'
    and bm.deactivated_at is null
    and bm.role in ('owner', 'manager');
  if v_membership_id is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return v_membership_id;
end;
$$;

revoke all on function public.assert_pos_manager(uuid) from public;

create or replace function public.pos_recompute_sale_status(
  p_total bigint,
  p_paid bigint,
  p_refunded bigint
)
returns public.sale_status
language plpgsql
immutable
as $$
declare
  v_net bigint := p_paid - p_refunded;
begin
  if p_refunded > 0 and v_net = 0 then
    return 'refunded';
  end if;
  if p_refunded > 0 and v_net > 0 then
    return 'partially_refunded';
  end if;
  if p_total = 0 or v_net = p_total then
    return 'paid';
  end if;
  if p_paid > 0 and v_net < p_total then
    return 'partially_paid';
  end if;
  return 'open';
end;
$$;

-- Resolve + price lines, allocate discount, compute tax. Returns jsonb { lines, subtotal, discount, tax, total }
create or replace function public.pos_calculate_sale_from_lines(
  p_business_id uuid,
  p_location_id uuid,
  p_currency text,
  p_lines jsonb,
  p_discount_minor bigint,
  p_tax_enabled boolean,
  p_tax_rate_bps integer,
  p_allow_custom boolean,
  p_allow_discount boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_kind text;
  v_qty integer;
  v_unit bigint;
  v_name text;
  v_service_id uuid;
  v_addon_id uuid;
  v_staff uuid;
  v_service public.services%rowtype;
  v_addon public.service_addons%rowtype;
  v_rows jsonb := '[]'::jsonb;
  v_subtotal bigint := 0;
  v_discount bigint := coalesce(p_discount_minor, 0);
  v_tax bigint := 0;
  v_i integer := 0;
  v_alloc bigint[];
  v_floors bigint[];
  v_taxables bigint[];
  v_taxes bigint[];
  v_subtotals bigint[];
  v_names text[];
  v_kinds text[];
  v_qtys integer[];
  v_units bigint[];
  v_svc uuid[];
  v_adn uuid[];
  v_staffs uuid[];
  v_count integer := 0;
  v_raw numeric;
  v_sum_floor bigint := 0;
  v_remainder bigint;
  v_idx integer;
  v_out_lines jsonb := '[]'::jsonb;
  v_line_total bigint;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_discount < 0 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_discount > 0 and not p_allow_discount then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    v_kind := v_item->>'kind';
    v_qty := coalesce((v_item->>'quantity')::int, 1);
    v_staff := nullif(v_item->>'staffMembershipId', '')::uuid;
    if v_qty < 1 or v_qty > 100 then
      raise exception 'VALIDATION_ERROR' using errcode = '22023';
    end if;

    if v_kind = 'service' then
      v_service_id := (v_item->>'sourceServiceId')::uuid;
      select * into v_service from public.services
      where id = v_service_id and business_id = p_business_id;
      if not found or v_service.archived_at is not null then
        raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002';
      end if;
      if v_service.currency is distinct from p_currency then
        raise exception 'CURRENCY_MISMATCH' using errcode = '22023';
      end if;
      v_name := v_service.name;
      select coalesce(
        (select sls.price_minor from public.service_location_settings sls
         where sls.service_id = v_service_id and sls.location_id = p_location_id),
        v_service.price_minor
      ) into v_unit;
      v_addon_id := null;
    elsif v_kind = 'addon' then
      v_addon_id := (v_item->>'sourceAddonId')::uuid;
      select * into v_addon from public.service_addons
      where id = v_addon_id and business_id = p_business_id;
      if not found or v_addon.archived_at is not null then
        raise exception 'ADDON_INVALID' using errcode = '22023';
      end if;
      if v_addon.currency is distinct from p_currency then
        raise exception 'CURRENCY_MISMATCH' using errcode = '22023';
      end if;
      v_name := v_addon.name;
      v_unit := v_addon.price_minor;
      v_service_id := null;
    elsif v_kind = 'custom' then
      if not p_allow_custom then
        raise exception 'FORBIDDEN' using errcode = '42501';
      end if;
      v_name := trim(v_item->>'name');
      v_unit := coalesce((v_item->>'unitPriceMinor')::bigint, -1);
      if v_name is null or char_length(v_name) < 1 or v_unit < 0 then
        raise exception 'VALIDATION_ERROR' using errcode = '22023';
      end if;
      v_service_id := null;
      v_addon_id := null;
    else
      raise exception 'VALIDATION_ERROR' using errcode = '22023';
    end if;

    v_count := v_count + 1;
    v_subtotals := array_append(v_subtotals, v_qty * v_unit);
    v_names := array_append(v_names, v_name);
    v_kinds := array_append(v_kinds, v_kind);
    v_qtys := array_append(v_qtys, v_qty);
    v_units := array_append(v_units, v_unit);
    v_svc := array_append(v_svc, v_service_id);
    v_adn := array_append(v_adn, v_addon_id);
    v_staffs := array_append(v_staffs, v_staff);
    v_subtotal := v_subtotal + (v_qty * v_unit);
  end loop;

  if v_discount > v_subtotal then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  -- allocate discount: floor then remainder by sort order
  for v_idx in 1..v_count loop
    if v_subtotal = 0 then
      v_floors := array_append(v_floors, 0::bigint);
    else
      v_raw := (v_discount::numeric * v_subtotals[v_idx]::numeric) / v_subtotal::numeric;
      v_floors := array_append(v_floors, floor(v_raw)::bigint);
      v_sum_floor := v_sum_floor + floor(v_raw)::bigint;
    end if;
  end loop;
  v_remainder := v_discount - v_sum_floor;
  v_alloc := v_floors;
  v_idx := 1;
  while v_remainder > 0 and v_idx <= v_count loop
    if v_subtotals[v_idx] > 0 then
      v_alloc[v_idx] := v_alloc[v_idx] + 1;
      v_remainder := v_remainder - 1;
    end if;
    v_idx := v_idx + 1;
  end loop;

  for v_idx in 1..v_count loop
    v_taxables := array_append(v_taxables, v_subtotals[v_idx] - v_alloc[v_idx]);
    if p_tax_enabled and p_tax_rate_bps > 0 then
      v_taxes := array_append(
        v_taxes,
        floor((v_subtotals[v_idx] - v_alloc[v_idx])::numeric * p_tax_rate_bps / 10000)::bigint
      );
    else
      v_taxes := array_append(v_taxes, 0::bigint);
    end if;
    v_tax := v_tax + v_taxes[v_idx];
    v_line_total := (v_subtotals[v_idx] - v_alloc[v_idx]) + v_taxes[v_idx];
    v_out_lines := v_out_lines || jsonb_build_array(jsonb_build_object(
      'kind', v_kinds[v_idx],
      'sourceServiceId', v_svc[v_idx],
      'sourceAddonId', v_adn[v_idx],
      'name', v_names[v_idx],
      'quantity', v_qtys[v_idx],
      'unitPriceMinor', v_units[v_idx],
      'lineSubtotalMinor', v_subtotals[v_idx],
      'allocatedDiscountMinor', v_alloc[v_idx],
      'taxableMinor', v_taxables[v_idx],
      'taxMinor', v_taxes[v_idx],
      'lineTotalMinor', v_line_total,
      'staffMembershipId', v_staffs[v_idx],
      'sortOrder', v_idx - 1
    ));
  end loop;

  return jsonb_build_object(
    'lines', v_out_lines,
    'subtotalMinor', v_subtotal,
    'discountMinor', v_discount,
    'taxMinor', v_tax,
    'totalMinor', v_subtotal - v_discount + v_tax
  );
end;
$$;

revoke all on function public.pos_calculate_sale_from_lines(
  uuid, uuid, text, jsonb, bigint, boolean, integer, boolean, boolean
) from public;

create or replace function public.pos_insert_sale_lines(
  p_sale_id uuid,
  p_business_id uuid,
  p_currency text,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
begin
  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.sale_lines (
      sale_id, business_id, kind, source_service_id, source_addon_id, name, quantity,
      unit_price_minor, line_subtotal_minor, allocated_discount_minor, taxable_minor,
      tax_minor, line_total_minor, currency, sort_order, staff_membership_id
    ) values (
      p_sale_id,
      p_business_id,
      (v_item->>'kind')::public.sale_line_kind,
      nullif(v_item->>'sourceServiceId', '')::uuid,
      nullif(v_item->>'sourceAddonId', '')::uuid,
      v_item->>'name',
      (v_item->>'quantity')::int,
      (v_item->>'unitPriceMinor')::bigint,
      (v_item->>'lineSubtotalMinor')::bigint,
      (v_item->>'allocatedDiscountMinor')::bigint,
      (v_item->>'taxableMinor')::bigint,
      (v_item->>'taxMinor')::bigint,
      (v_item->>'lineTotalMinor')::bigint,
      p_currency,
      (v_item->>'sortOrder')::int,
      nullif(v_item->>'staffMembershipId', '')::uuid
    );
  end loop;
end;
$$;

revoke all on function public.pos_insert_sale_lines(uuid, uuid, text, jsonb) from public;

create or replace function public.pos_sale_to_jsonb(p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    return null;
  end if;
  return to_jsonb(v_sale);
end;
$$;

revoke all on function public.pos_sale_to_jsonb(uuid) from public;

-- ---------------------------------------------------------------------------
-- create_walk_in_sale
-- ---------------------------------------------------------------------------
create or replace function public.create_walk_in_sale(
  p_business_id uuid,
  p_location_id uuid,
  p_customer_id uuid,
  p_lines jsonb,
  p_discount_minor bigint,
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
  v_auth record;
  v_business public.businesses%rowtype;
  v_location public.business_locations%rowtype;
  v_customer public.customers%rowtype;
  v_tax public.business_pos_tax_settings%rowtype;
  v_calc jsonb;
  v_sale_id uuid;
  v_existing public.sales%rowtype;
  v_status public.sale_status;
  v_allow_custom boolean;
  v_allow_discount boolean;
begin
  select * into v_auth from public.assert_can_manage_pos_location(p_business_id, p_location_id);
  v_allow_custom := v_auth.role in ('owner', 'manager');
  v_allow_discount := v_auth.role in ('owner', 'manager');

  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.sales
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.idempotency_payload_hash is distinct from p_idempotency_payload_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return public.pos_sale_to_jsonb(v_existing.id);
  end if;

  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'BUSINESS_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_location
  from public.business_locations
  where id = p_location_id and business_id = p_business_id and is_active = true;
  if not found then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers
    where id = p_customer_id and business_id = p_business_id;
    if not found then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_customer.archived_at is not null then
      raise exception 'CUSTOMER_ARCHIVED' using errcode = '22023';
    end if;
  end if;

  select * into v_tax from public.business_pos_tax_settings where business_id = p_business_id;
  if not found then
    v_tax.tax_enabled := false;
    v_tax.tax_name := null;
    v_tax.rate_bps := 0;
  end if;

  v_calc := public.pos_calculate_sale_from_lines(
    p_business_id, p_location_id, v_business.default_currency, p_lines,
    coalesce(p_discount_minor, 0), coalesce(v_tax.tax_enabled, false),
    coalesce(v_tax.rate_bps, 0), v_allow_custom, v_allow_discount
  );

  v_status := public.pos_recompute_sale_status((v_calc->>'totalMinor')::bigint, 0, 0);
  v_sale_id := gen_random_uuid();

  begin
    insert into public.sales (
      id, business_id, location_id, booking_id, customer_id, status, source, currency,
      subtotal_minor, discount_minor, tax_minor, total_minor,
      amount_paid_minor, amount_refunded_minor,
      tax_enabled, tax_name, tax_rate_bps, location_name, customer_name,
      reference_code, idempotency_key, idempotency_payload_hash, notes, created_by_user_id
    ) values (
      v_sale_id, p_business_id, p_location_id, null, p_customer_id, v_status, 'walk_in',
      v_business.default_currency,
      (v_calc->>'subtotalMinor')::bigint, (v_calc->>'discountMinor')::bigint,
      (v_calc->>'taxMinor')::bigint, (v_calc->>'totalMinor')::bigint,
      0, 0,
      coalesce(v_tax.tax_enabled, false), v_tax.tax_name, coalesce(v_tax.rate_bps, 0),
      v_location.name, case when p_customer_id is null then null else v_customer.full_name end,
      public.generate_sale_reference(p_business_id), p_idempotency_key, p_idempotency_payload_hash,
      nullif(trim(p_notes), ''), v_user
    );
  exception
    when unique_violation then
      select * into v_existing from public.sales
      where business_id = p_business_id and idempotency_key = p_idempotency_key;
      if found and v_existing.idempotency_payload_hash = p_idempotency_payload_hash then
        return public.pos_sale_to_jsonb(v_existing.id);
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end;

  perform public.pos_insert_sale_lines(v_sale_id, p_business_id, v_business.default_currency, v_calc->'lines');
  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (v_sale_id, p_business_id, 'created', v_user, jsonb_build_object('source', 'walk_in'));

  return public.pos_sale_to_jsonb(v_sale_id);
end;
$$;

revoke all on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) from public;
revoke all on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) from anon;
grant execute on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) to authenticated;

-- Priced lines (booking snapshots / already-resolved unit prices)
create or replace function public.pos_calculate_sale_from_booking_snapshots(
  p_lines jsonb,
  p_discount_minor bigint,
  p_tax_enabled boolean,
  p_tax_rate_bps integer,
  p_allow_discount boolean
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_item jsonb;
  v_qty integer;
  v_unit bigint;
  v_discount bigint := coalesce(p_discount_minor, 0);
  v_subtotal bigint := 0;
  v_tax bigint := 0;
  v_count integer := 0;
  v_subtotals bigint[];
  v_floors bigint[];
  v_alloc bigint[];
  v_taxes bigint[];
  v_sum_floor bigint := 0;
  v_remainder bigint;
  v_idx integer;
  v_raw numeric;
  v_out jsonb := '[]'::jsonb;
  v_kinds text[];
  v_names text[];
  v_qtys integer[];
  v_units bigint[];
  v_svc uuid[];
  v_adn uuid[];
begin
  if v_discount < 0 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_discount > 0 and not p_allow_discount then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := coalesce((v_item->>'quantity')::int, 1);
    v_unit := coalesce((v_item->>'unitPriceMinor')::bigint, -1);
    if v_qty < 1 or v_unit < 0 then
      raise exception 'VALIDATION_ERROR' using errcode = '22023';
    end if;
    v_count := v_count + 1;
    v_subtotals := array_append(v_subtotals, v_qty * v_unit);
    v_subtotal := v_subtotal + v_qty * v_unit;
    v_kinds := array_append(v_kinds, v_item->>'kind');
    v_names := array_append(v_names, v_item->>'name');
    v_qtys := array_append(v_qtys, v_qty);
    v_units := array_append(v_units, v_unit);
    v_svc := array_append(v_svc, nullif(v_item->>'sourceServiceId', '')::uuid);
    v_adn := array_append(v_adn, nullif(v_item->>'sourceAddonId', '')::uuid);
  end loop;
  if v_count < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_discount > v_subtotal then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  for v_idx in 1..v_count loop
    if v_subtotal = 0 then
      v_floors := array_append(v_floors, 0::bigint);
    else
      v_raw := (v_discount::numeric * v_subtotals[v_idx]::numeric) / v_subtotal::numeric;
      v_floors := array_append(v_floors, floor(v_raw)::bigint);
      v_sum_floor := v_sum_floor + floor(v_raw)::bigint;
    end if;
  end loop;
  v_remainder := v_discount - v_sum_floor;
  v_alloc := v_floors;
  v_idx := 1;
  while v_remainder > 0 and v_idx <= v_count loop
    if v_subtotals[v_idx] > 0 then
      v_alloc[v_idx] := v_alloc[v_idx] + 1;
      v_remainder := v_remainder - 1;
    end if;
    v_idx := v_idx + 1;
  end loop;
  for v_idx in 1..v_count loop
    if p_tax_enabled and p_tax_rate_bps > 0 then
      v_taxes := array_append(
        v_taxes,
        floor((v_subtotals[v_idx] - v_alloc[v_idx])::numeric * p_tax_rate_bps / 10000)::bigint
      );
    else
      v_taxes := array_append(v_taxes, 0::bigint);
    end if;
    v_tax := v_tax + v_taxes[v_idx];
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', v_kinds[v_idx],
      'sourceServiceId', v_svc[v_idx],
      'sourceAddonId', v_adn[v_idx],
      'name', v_names[v_idx],
      'quantity', v_qtys[v_idx],
      'unitPriceMinor', v_units[v_idx],
      'lineSubtotalMinor', v_subtotals[v_idx],
      'allocatedDiscountMinor', v_alloc[v_idx],
      'taxableMinor', v_subtotals[v_idx] - v_alloc[v_idx],
      'taxMinor', v_taxes[v_idx],
      'lineTotalMinor', (v_subtotals[v_idx] - v_alloc[v_idx]) + v_taxes[v_idx],
      'staffMembershipId', null,
      'sortOrder', v_idx - 1
    ));
  end loop;
  return jsonb_build_object(
    'lines', v_out,
    'subtotalMinor', v_subtotal,
    'discountMinor', v_discount,
    'taxMinor', v_tax,
    'totalMinor', v_subtotal - v_discount + v_tax
  );
end;
$$;

revoke all on function public.pos_calculate_sale_from_booking_snapshots(
  jsonb, bigint, boolean, integer, boolean
) from public;

-- ---------------------------------------------------------------------------
-- checkout_booking_to_sale
-- ---------------------------------------------------------------------------
create or replace function public.checkout_booking_to_sale(
  p_business_id uuid,
  p_booking_id uuid,
  p_discount_minor bigint,
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
  v_auth record;
  v_booking public.bookings%rowtype;
  v_business public.businesses%rowtype;
  v_tax public.business_pos_tax_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_svc record;
  v_addon record;
  v_calc jsonb;
  v_sale_id uuid;
  v_existing public.sales%rowtype;
  v_active public.sales%rowtype;
  v_status public.sale_status;
  v_allow_discount boolean;
  v_order integer := 0;
begin
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.sales
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.idempotency_payload_hash is distinct from p_idempotency_payload_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return public.pos_sale_to_jsonb(v_existing.id);
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found or v_booking.business_id is distinct from p_business_id then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_auth from public.assert_can_manage_pos_location(p_business_id, v_booking.location_id);
  v_allow_discount := v_auth.role in ('owner', 'manager');

  if v_booking.status not in ('confirmed', 'completed') then
    raise exception 'BOOKING_NOT_CHECKOUTABLE' using errcode = '22023';
  end if;

  select * into v_active
  from public.sales
  where booking_id = p_booking_id and status <> 'voided';
  if found then
    raise exception 'SALE_CONFLICT' using errcode = '23505';
  end if;

  select * into v_business from public.businesses where id = p_business_id;
  select * into v_tax from public.business_pos_tax_settings where business_id = p_business_id;
  if not found then
    v_tax.tax_enabled := false;
    v_tax.tax_name := null;
    v_tax.rate_bps := 0;
  end if;

  for v_svc in
    select * from public.booking_services where booking_id = p_booking_id order by sort_order, created_at
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'kind', 'service',
      'sourceServiceId', v_svc.service_id,
      'name', v_svc.service_name,
      'quantity', 1,
      'unitPriceMinor', v_svc.price_minor,
      'sortOrder', v_order
    ));
    v_order := v_order + 1;
  end loop;
  for v_addon in
    select * from public.booking_addons where booking_id = p_booking_id order by sort_order, created_at
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'kind', 'addon',
      'sourceAddonId', v_addon.addon_id,
      'name', v_addon.addon_name,
      'quantity', 1,
      'unitPriceMinor', v_addon.price_minor,
      'sortOrder', v_order
    ));
    v_order := v_order + 1;
  end loop;

  if jsonb_array_length(v_lines) < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  -- Use snapshotted unit prices via custom-like path: recalculate using provided unit prices
  -- by temporarily treating booking lines as custom for pricing fidelity while keeping kinds.
  -- Re-price from booking snapshots directly:
  v_calc := public.pos_calculate_sale_from_booking_snapshots(
    v_lines, coalesce(p_discount_minor, 0), coalesce(v_tax.tax_enabled, false),
    coalesce(v_tax.rate_bps, 0), v_allow_discount
  );

  v_status := public.pos_recompute_sale_status((v_calc->>'totalMinor')::bigint, 0, 0);
  v_sale_id := gen_random_uuid();

  begin
    insert into public.sales (
      id, business_id, location_id, booking_id, customer_id, status, source, currency,
      subtotal_minor, discount_minor, tax_minor, total_minor,
      amount_paid_minor, amount_refunded_minor,
      tax_enabled, tax_name, tax_rate_bps, location_name, customer_name,
      reference_code, idempotency_key, idempotency_payload_hash, notes, created_by_user_id
    ) values (
      v_sale_id, p_business_id, v_booking.location_id, p_booking_id, v_booking.customer_id,
      v_status, 'booking', v_business.default_currency,
      (v_calc->>'subtotalMinor')::bigint, (v_calc->>'discountMinor')::bigint,
      (v_calc->>'taxMinor')::bigint, (v_calc->>'totalMinor')::bigint,
      0, 0,
      coalesce(v_tax.tax_enabled, false), v_tax.tax_name, coalesce(v_tax.rate_bps, 0),
      v_booking.location_name, v_booking.customer_name,
      public.generate_sale_reference(p_business_id), p_idempotency_key, p_idempotency_payload_hash,
      nullif(trim(p_notes), ''), v_user
    );
  exception
    when unique_violation then
      select * into v_existing from public.sales
      where business_id = p_business_id and idempotency_key = p_idempotency_key;
      if found and v_existing.idempotency_payload_hash = p_idempotency_payload_hash then
        return public.pos_sale_to_jsonb(v_existing.id);
      end if;
      select * into v_active from public.sales
      where booking_id = p_booking_id and status <> 'voided';
      if found then
        raise exception 'SALE_CONFLICT' using errcode = '23505';
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end;

  perform public.pos_insert_sale_lines(v_sale_id, p_business_id, v_business.default_currency, v_calc->'lines');
  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (v_sale_id, p_business_id, 'created', v_user, jsonb_build_object('source', 'booking', 'bookingId', p_booking_id));

  return public.pos_sale_to_jsonb(v_sale_id);
end;
$$;

revoke all on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) from public;
revoke all on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) from anon;
grant execute on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) to authenticated;
