-- Phase 09 remediation: persist update_open_sale idempotency key/hash for replay/conflict.

alter table public.sales
  add column if not exists update_idempotency_key text,
  add column if not exists update_idempotency_payload_hash text;

create unique index if not exists sales_update_idempotency_unique
  on public.sales (business_id, update_idempotency_key)
  where update_idempotency_key is not null;

comment on column public.sales.update_idempotency_key is
  'Optional idempotency key for the latest successful update_open_sale call';
comment on column public.sales.update_idempotency_payload_hash is
  'Payload hash bound to update_idempotency_key; mismatch yields IDEMPOTENCY_CONFLICT';

create or replace function public.update_open_sale(
  p_business_id uuid,
  p_sale_id uuid,
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
  v_sale public.sales%rowtype;
  v_tax public.business_pos_tax_settings%rowtype;
  v_calc jsonb;
  v_before jsonb;
  v_status public.sale_status;
  v_key text := nullif(trim(p_idempotency_key), '');
  v_hash text := nullif(trim(p_idempotency_payload_hash), '');
begin
  perform public.assert_pos_manager(p_business_id);

  if v_key is not null and char_length(v_key) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_key is not null and (v_hash is null or char_length(v_hash) < 8) then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  -- Replay / conflict before row lock when key already bound to another sale
  if v_key is not null then
    select * into v_sale
    from public.sales
    where business_id = p_business_id and update_idempotency_key = v_key;
    if found then
      if v_sale.id is distinct from p_sale_id then
        raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
      end if;
      if v_sale.update_idempotency_payload_hash is distinct from v_hash then
        raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
      end if;
      return public.pos_sale_to_jsonb(p_sale_id);
    end if;
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.business_id is distinct from p_business_id then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.assert_can_manage_pos_location(p_business_id, v_sale.location_id);

  -- Same-sale replay after lock (covers race that inserted the key concurrently)
  if v_key is not null
     and v_sale.update_idempotency_key is not distinct from v_key
  then
    if v_sale.update_idempotency_payload_hash is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return public.pos_sale_to_jsonb(p_sale_id);
  end if;

  if v_sale.status is distinct from 'open'
     or v_sale.amount_paid_minor <> 0
     or v_sale.amount_refunded_minor <> 0
  then
    raise exception 'SALE_NOT_EDITABLE' using errcode = '22023';
  end if;

  select * into v_tax from public.business_pos_tax_settings where business_id = p_business_id;
  if not found then
    v_tax.tax_enabled := false;
    v_tax.tax_name := null;
    v_tax.rate_bps := 0;
  end if;

  v_before := jsonb_build_object(
    'subtotalMinor', v_sale.subtotal_minor,
    'discountMinor', v_sale.discount_minor,
    'taxMinor', v_sale.tax_minor,
    'totalMinor', v_sale.total_minor
  );

  v_calc := public.pos_calculate_sale_from_lines(
    p_business_id, v_sale.location_id, v_sale.currency, p_lines,
    coalesce(p_discount_minor, 0), coalesce(v_tax.tax_enabled, false),
    coalesce(v_tax.rate_bps, 0), true, true
  );

  v_status := public.pos_recompute_sale_status((v_calc->>'totalMinor')::bigint, 0, 0);

  delete from public.sale_lines where sale_id = p_sale_id;
  perform public.pos_insert_sale_lines(p_sale_id, p_business_id, v_sale.currency, v_calc->'lines');

  begin
    update public.sales set
      subtotal_minor = (v_calc->>'subtotalMinor')::bigint,
      discount_minor = (v_calc->>'discountMinor')::bigint,
      tax_minor = (v_calc->>'taxMinor')::bigint,
      total_minor = (v_calc->>'totalMinor')::bigint,
      status = v_status,
      tax_enabled = coalesce(v_tax.tax_enabled, false),
      tax_name = v_tax.tax_name,
      tax_rate_bps = coalesce(v_tax.rate_bps, 0),
      notes = nullif(trim(p_notes), ''),
      update_idempotency_key = v_key,
      update_idempotency_payload_hash = v_hash
    where id = p_sale_id;
  exception
    when unique_violation then
      select * into v_sale
      from public.sales
      where business_id = p_business_id and update_idempotency_key = v_key;
      if found
         and v_sale.id = p_sale_id
         and v_sale.update_idempotency_payload_hash is not distinct from v_hash
      then
        return public.pos_sale_to_jsonb(p_sale_id);
      end if;
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end;

  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (
    p_sale_id, p_business_id, 'sale_updated', v_user,
    jsonb_build_object(
      'before', v_before,
      'after', jsonb_build_object(
        'subtotalMinor', (v_calc->>'subtotalMinor')::bigint,
        'discountMinor', (v_calc->>'discountMinor')::bigint,
        'taxMinor', (v_calc->>'taxMinor')::bigint,
        'totalMinor', (v_calc->>'totalMinor')::bigint
      ),
      'lineCount', jsonb_array_length(v_calc->'lines'),
      'idempotencyKey', v_key
    )
  );

  return public.pos_sale_to_jsonb(p_sale_id);
end;
$$;

revoke all on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) from public;
revoke all on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) from anon;
grant execute on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) to authenticated;
