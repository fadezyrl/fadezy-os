-- Phase 09: POS mutation RPCs (update, pay, refund, void, register)

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
begin
  perform public.assert_pos_manager(p_business_id);

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.business_id is distinct from p_business_id then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.assert_can_manage_pos_location(p_business_id, v_sale.location_id);

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

  update public.sales set
    subtotal_minor = (v_calc->>'subtotalMinor')::bigint,
    discount_minor = (v_calc->>'discountMinor')::bigint,
    tax_minor = (v_calc->>'taxMinor')::bigint,
    total_minor = (v_calc->>'totalMinor')::bigint,
    status = v_status,
    tax_enabled = coalesce(v_tax.tax_enabled, false),
    tax_name = v_tax.tax_name,
    tax_rate_bps = coalesce(v_tax.rate_bps, 0),
    notes = nullif(trim(p_notes), '')
  where id = p_sale_id;

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
      'lineCount', jsonb_array_length(v_calc->'lines')
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

create or replace function public.record_sale_payment(
  p_business_id uuid,
  p_sale_id uuid,
  p_amount_minor bigint,
  p_method_kind public.payment_method_kind,
  p_method_label text,
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
  v_session public.register_sessions%rowtype;
  v_payment_id uuid;
  v_existing public.sale_payments%rowtype;
  v_balance bigint;
  v_status public.sale_status;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'PAYMENT_INVALID' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.sale_payments
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    return public.pos_sale_to_jsonb(v_existing.sale_id);
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.business_id is distinct from p_business_id then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.assert_can_manage_pos_location(p_business_id, v_sale.location_id);

  if v_sale.status = 'voided' then
    raise exception 'SALE_VOIDED' using errcode = '22023';
  end if;

  v_balance := v_sale.total_minor - (v_sale.amount_paid_minor - v_sale.amount_refunded_minor);
  if p_amount_minor > v_balance then
    raise exception 'PAYMENT_INVALID' using errcode = '22023';
  end if;
  if v_sale.total_minor = 0 then
    raise exception 'PAYMENT_INVALID' using errcode = '22023';
  end if;

  if p_method_kind = 'cash' then
    select * into v_session
    from public.register_sessions
    where location_id = v_sale.location_id and status = 'open'
    for update;
    if not found then
      raise exception 'REGISTER_REQUIRED' using errcode = '22023';
    end if;
  end if;

  v_payment_id := gen_random_uuid();
  begin
    insert into public.sale_payments (
      id, sale_id, business_id, amount_minor, currency, method_kind, method_label,
      register_session_id, idempotency_key, recorded_by_user_id, notes
    ) values (
      v_payment_id, p_sale_id, p_business_id, p_amount_minor, v_sale.currency, p_method_kind,
      nullif(trim(p_method_label), ''),
      case when p_method_kind = 'cash' then v_session.id else null end,
      p_idempotency_key, v_user, nullif(trim(p_notes), '')
    );
  exception
    when unique_violation then
      select * into v_existing from public.sale_payments
      where business_id = p_business_id and idempotency_key = p_idempotency_key;
      if found then
        return public.pos_sale_to_jsonb(v_existing.sale_id);
      end if;
      raise;
  end;

  if p_method_kind = 'cash' then
    insert into public.register_cash_movements (
      session_id, business_id, kind, amount_minor, sale_payment_id, actor_user_id
    ) values (
      v_session.id, p_business_id, 'cash_payment', p_amount_minor, v_payment_id, v_user
    );
  end if;

  update public.sales
  set amount_paid_minor = amount_paid_minor + p_amount_minor
  where id = p_sale_id
  returning * into v_sale;

  v_status := public.pos_recompute_sale_status(
    v_sale.total_minor, v_sale.amount_paid_minor, v_sale.amount_refunded_minor
  );
  update public.sales set status = v_status where id = p_sale_id;

  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (
    p_sale_id, p_business_id, 'payment_recorded', v_user,
    jsonb_build_object('paymentId', v_payment_id, 'amountMinor', p_amount_minor, 'methodKind', p_method_kind)
  );

  return public.pos_sale_to_jsonb(p_sale_id);
end;
$$;

revoke all on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) from public;
revoke all on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) from anon;
grant execute on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) to authenticated;

create or replace function public.refund_sale_payment(
  p_business_id uuid,
  p_sale_id uuid,
  p_payment_id uuid,
  p_amount_minor bigint,
  p_reason text,
  p_method_kind public.payment_method_kind,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_payment public.sale_payments%rowtype;
  v_session public.register_sessions%rowtype;
  v_refunded bigint;
  v_remaining bigint;
  v_refund_id uuid;
  v_existing public.sale_refunds%rowtype;
  v_method public.payment_method_kind;
  v_status public.sale_status;
begin
  perform public.assert_pos_manager(p_business_id);

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'PAYMENT_INVALID' using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) < 8 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.sale_refunds
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    return public.pos_sale_to_jsonb(v_existing.sale_id);
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.business_id is distinct from p_business_id then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'SALE_VOIDED' using errcode = '22023';
  end if;

  select * into v_payment from public.sale_payments where id = p_payment_id for update;
  if not found or v_payment.sale_id is distinct from p_sale_id then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(sum(amount_minor), 0) into v_refunded
  from public.sale_refunds where payment_id = p_payment_id;
  v_remaining := v_payment.amount_minor - v_refunded;
  if p_amount_minor > v_remaining then
    raise exception 'REFUND_EXCEEDS_PAID' using errcode = '22023';
  end if;

  v_method := coalesce(p_method_kind, v_payment.method_kind);
  if v_method = 'cash' then
    select * into v_session
    from public.register_sessions
    where location_id = v_sale.location_id and status = 'open'
    for update;
    if not found then
      raise exception 'REGISTER_REQUIRED' using errcode = '22023';
    end if;
  end if;

  v_refund_id := gen_random_uuid();
  begin
    insert into public.sale_refunds (
      id, sale_id, payment_id, business_id, amount_minor, currency, reason, method_kind,
      register_session_id, idempotency_key, recorded_by_user_id
    ) values (
      v_refund_id, p_sale_id, p_payment_id, p_business_id, p_amount_minor, v_sale.currency,
      trim(p_reason), v_method,
      case when v_method = 'cash' then v_session.id else null end,
      p_idempotency_key, v_user
    );
  exception
    when unique_violation then
      select * into v_existing from public.sale_refunds
      where business_id = p_business_id and idempotency_key = p_idempotency_key;
      if found then
        return public.pos_sale_to_jsonb(v_existing.sale_id);
      end if;
      raise;
  end;

  if v_method = 'cash' then
    insert into public.register_cash_movements (
      session_id, business_id, kind, amount_minor, sale_refund_id, actor_user_id, note
    ) values (
      v_session.id, p_business_id, 'cash_refund', p_amount_minor, v_refund_id, v_user, trim(p_reason)
    );
  end if;

  update public.sales
  set amount_refunded_minor = amount_refunded_minor + p_amount_minor
  where id = p_sale_id
  returning * into v_sale;

  v_status := public.pos_recompute_sale_status(
    v_sale.total_minor, v_sale.amount_paid_minor, v_sale.amount_refunded_minor
  );
  update public.sales set status = v_status where id = p_sale_id;

  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (
    p_sale_id, p_business_id, 'refund_recorded', v_user,
    jsonb_build_object('refundId', v_refund_id, 'paymentId', p_payment_id, 'amountMinor', p_amount_minor)
  );

  return public.pos_sale_to_jsonb(p_sale_id);
end;
$$;

revoke all on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) from public;
revoke all on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) from anon;
grant execute on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) to authenticated;

create or replace function public.void_sale(
  p_business_id uuid,
  p_sale_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_sale public.sales%rowtype;
begin
  perform public.assert_pos_manager(p_business_id);
  if p_reason is null or char_length(trim(p_reason)) < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.business_id is distinct from p_business_id then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sale.status = 'voided' then
    return public.pos_sale_to_jsonb(p_sale_id);
  end if;
  if v_sale.amount_paid_minor <> 0 or v_sale.amount_refunded_minor <> 0 then
    raise exception 'SALE_NOT_VOIDABLE' using errcode = '22023';
  end if;

  update public.sales set
    status = 'voided',
    void_reason = trim(p_reason),
    voided_at = timezone('utc', now()),
    voided_by_user_id = v_user
  where id = p_sale_id;

  insert into public.sale_events (sale_id, business_id, event_type, actor_user_id, payload)
  values (p_sale_id, p_business_id, 'voided', v_user, jsonb_build_object('reason', trim(p_reason)));

  return public.pos_sale_to_jsonb(p_sale_id);
end;
$$;

revoke all on function public.void_sale(uuid, uuid, text) from public;
revoke all on function public.void_sale(uuid, uuid, text) from anon;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;

create or replace function public.open_register_session(
  p_business_id uuid,
  p_location_id uuid,
  p_opening_float_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session_id uuid;
  v_existing public.register_sessions%rowtype;
begin
  perform public.assert_pos_manager(p_business_id);
  perform public.assert_can_manage_pos_location(p_business_id, p_location_id);
  if p_opening_float_minor is null or p_opening_float_minor < 0 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_existing
  from public.register_sessions
  where location_id = p_location_id and status = 'open';
  if found then
    raise exception 'REGISTER_ALREADY_OPEN' using errcode = '23505';
  end if;

  if not exists (
    select 1 from public.business_locations
    where id = p_location_id and business_id = p_business_id and is_active = true
  ) then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_session_id := gen_random_uuid();
  begin
    insert into public.register_sessions (
      id, business_id, location_id, status, opening_float_minor, opened_by_user_id
    ) values (
      v_session_id, p_business_id, p_location_id, 'open', p_opening_float_minor, v_user
    );
  exception
    when unique_violation then
      raise exception 'REGISTER_ALREADY_OPEN' using errcode = '23505';
  end;

  insert into public.register_cash_movements (
    session_id, business_id, kind, amount_minor, actor_user_id, note
  ) values (
    v_session_id, p_business_id, 'open_float', p_opening_float_minor, v_user, 'Opening float'
  );

  return to_jsonb((select s from public.register_sessions s where s.id = v_session_id));
end;
$$;

revoke all on function public.open_register_session(uuid, uuid, bigint) from public;
revoke all on function public.open_register_session(uuid, uuid, bigint) from anon;
grant execute on function public.open_register_session(uuid, uuid, bigint) to authenticated;

create or replace function public.close_register_session(
  p_business_id uuid,
  p_session_id uuid,
  p_counted_minor bigint,
  p_discrepancy_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session public.register_sessions%rowtype;
  v_expected bigint;
begin
  perform public.assert_pos_manager(p_business_id);
  if p_counted_minor is null or p_counted_minor < 0 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_session from public.register_sessions where id = p_session_id for update;
  if not found or v_session.business_id is distinct from p_business_id then
    raise exception 'REGISTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_session.status = 'closed' then
    return to_jsonb(v_session);
  end if;

  v_expected := public.register_session_expected_minor(p_session_id);

  insert into public.register_cash_movements (
    session_id, business_id, kind, amount_minor, actor_user_id, note
  ) values (
    p_session_id, p_business_id, 'close_count', p_counted_minor, v_user, 'Closing count'
  );

  update public.register_sessions set
    status = 'closed',
    closed_at = timezone('utc', now()),
    closed_by_user_id = v_user,
    expected_minor = v_expected,
    counted_minor = p_counted_minor,
    discrepancy_minor = p_counted_minor - v_expected,
    discrepancy_note = nullif(trim(p_discrepancy_note), '')
  where id = p_session_id
  returning * into v_session;

  return to_jsonb(v_session);
end;
$$;

revoke all on function public.close_register_session(uuid, uuid, bigint, text) from public;
revoke all on function public.close_register_session(uuid, uuid, bigint, text) from anon;
grant execute on function public.close_register_session(uuid, uuid, bigint, text) to authenticated;

create or replace function public.post_register_cash_adjustment(
  p_business_id uuid,
  p_session_id uuid,
  p_kind public.cash_movement_kind,
  p_amount_minor bigint,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session public.register_sessions%rowtype;
begin
  perform public.assert_pos_manager(p_business_id);
  if p_kind not in ('cash_in', 'cash_out') then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_note is null or char_length(trim(p_note)) < 1 then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  select * into v_session from public.register_sessions where id = p_session_id for update;
  if not found or v_session.business_id is distinct from p_business_id then
    raise exception 'REGISTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_session.status is distinct from 'open' then
    raise exception 'REGISTER_CLOSED' using errcode = '22023';
  end if;

  insert into public.register_cash_movements (
    session_id, business_id, kind, amount_minor, note, actor_user_id
  ) values (
    p_session_id, p_business_id, p_kind, p_amount_minor, trim(p_note), v_user
  );

  return to_jsonb(v_session);
end;
$$;

revoke all on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) from public;
revoke all on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) from anon;
grant execute on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) to authenticated;
