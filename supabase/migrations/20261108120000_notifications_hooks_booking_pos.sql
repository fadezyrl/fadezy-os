-- Phase 10 v1: atomic capture from booking_status_events + sale_events (same TX as RPCs)

create or replace function public.notify_on_booking_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_staff_user uuid;
  v_payload jsonb;
  v_event_type text;
  v_key text;
  v_biz_name text;
begin
  select * into v_booking from public.bookings where id = new.booking_id;
  if not found then
    return new;
  end if;

  select bm.user_id into v_staff_user
  from public.business_members bm
  where bm.id = v_booking.staff_membership_id;

  select name into v_biz_name from public.businesses where id = new.business_id;

  v_payload := jsonb_build_object(
    'title', 'Booking update',
    'body', coalesce(v_booking.customer_name, 'Customer') || ' · ' || to_char(v_booking.starts_at at time zone v_booking.timezone, 'YYYY-MM-DD HH24:MI'),
    'href', '/workspace/' || new.business_id::text || '?tab=bookings',
    'businessName', v_biz_name,
    'bookingId', v_booking.id,
    'referenceCode', v_booking.reference_code,
    'customerName', v_booking.customer_name,
    'customerEmail', coalesce(
      (select c.email from public.customers c where c.id = v_booking.customer_id),
      v_booking.customer_email
    ),
    'startsAt', v_booking.starts_at,
    'endsAt', v_booking.ends_at,
    'timezone', v_booking.timezone,
    'locationName', v_booking.location_name,
    'staffDisplayName', v_booking.staff_display_name,
    'staffUserId', v_staff_user,
    'status', new.to_status
  );

  if new.from_status is null and new.to_status = 'confirmed' then
    v_event_type := 'booking.created';
    v_key := 'booking.created:' || v_booking.id::text;
    perform public.emit_notification_event(
      new.business_id, v_event_type, 'booking', v_booking.id, v_key, v_payload, new.actor_user_id
    );
    perform public.schedule_booking_reminder_24h(v_booking.id);

  elsif new.note = 'rescheduled' and new.to_status = 'confirmed' then
    v_event_type := 'booking.rescheduled';
    v_key := 'booking.rescheduled:' || new.id::text;
    v_payload := v_payload || jsonb_build_object(
      'title', 'Booking rescheduled',
      'previousStartsAt', new.previous_starts_at
    );
    perform public.cancel_booking_reminder_state(v_booking.id);
    perform public.emit_notification_event(
      new.business_id, v_event_type, 'booking', v_booking.id, v_key, v_payload, new.actor_user_id
    );
    perform public.schedule_booking_reminder_24h(v_booking.id);

  elsif new.to_status = 'cancelled' then
    v_event_type := 'booking.cancelled';
    v_key := 'booking.cancelled:' || v_booking.id::text;
    v_payload := v_payload || jsonb_build_object('title', 'Booking cancelled');
    perform public.cancel_booking_reminder_state(v_booking.id);
    perform public.emit_notification_event(
      new.business_id, v_event_type, 'booking', v_booking.id, v_key, v_payload, new.actor_user_id
    );

  elsif new.to_status = 'completed' then
    v_event_type := 'booking.completed';
    v_key := 'booking.completed:' || v_booking.id::text;
    perform public.cancel_booking_reminder_state(v_booking.id);
    perform public.emit_notification_event(
      new.business_id, v_event_type, 'booking', v_booking.id, v_key,
      v_payload || jsonb_build_object('title', 'Booking completed'), new.actor_user_id
    );

  elsif new.to_status = 'no_show' then
    v_event_type := 'booking.no_show';
    v_key := 'booking.no_show:' || v_booking.id::text;
    perform public.cancel_booking_reminder_state(v_booking.id);
    perform public.emit_notification_event(
      new.business_id, v_event_type, 'booking', v_booking.id, v_key,
      v_payload || jsonb_build_object('title', 'Booking no-show'), new.actor_user_id
    );
  end if;

  return new;
end;
$$;

revoke all on function public.notify_on_booking_status_event() from public;
revoke all on function public.notify_on_booking_status_event() from anon;
revoke all on function public.notify_on_booking_status_event() from authenticated;

drop trigger if exists trg_notify_on_booking_status_event on public.booking_status_events;
create trigger trg_notify_on_booking_status_event
after insert on public.booking_status_events
for each row execute function public.notify_on_booking_status_event();

create or replace function public.notify_on_sale_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_event_type text;
  v_key text;
  v_payload jsonb;
  v_biz_name text;
begin
  -- Optional POS in-app only
  if new.event_type not in ('created', 'payment_recorded', 'refund_recorded', 'voided') then
    return new;
  end if;

  select * into v_sale from public.sales where id = new.sale_id;
  if not found then
    return new;
  end if;

  select name into v_biz_name from public.businesses where id = new.business_id;

  v_event_type := case new.event_type
    when 'created' then 'sale.created'
    when 'payment_recorded' then 'sale.payment_recorded'
    when 'refund_recorded' then 'sale.refund_recorded'
    when 'voided' then 'sale.voided'
  end;

  v_key := case new.event_type
    when 'created' then 'sale.created:' || v_sale.id::text
    when 'payment_recorded' then 'sale.payment:' || coalesce(new.payload->>'paymentId', new.id::text)
    when 'refund_recorded' then 'sale.refund:' || coalesce(new.payload->>'refundId', new.id::text)
    when 'voided' then 'sale.voided:' || v_sale.id::text
  end;

  v_payload := jsonb_build_object(
    'title', 'Sale ' || new.event_type,
    'body', coalesce(v_sale.reference_code, v_sale.id::text) || ' · ' || v_sale.total_minor::text,
    'href', '/workspace/' || new.business_id::text || '/pos/sales/' || v_sale.id::text,
    'businessName', v_biz_name,
    'saleId', v_sale.id,
    'referenceCode', v_sale.reference_code,
    'totalMinor', v_sale.total_minor,
    'currency', v_sale.currency,
    'status', v_sale.status
  );

  perform public.emit_notification_event(
    new.business_id, v_event_type, 'sale', v_sale.id, v_key, v_payload, new.actor_user_id
  );
  return new;
end;
$$;

revoke all on function public.notify_on_sale_event() from public;
revoke all on function public.notify_on_sale_event() from anon;
revoke all on function public.notify_on_sale_event() from authenticated;

drop trigger if exists trg_notify_on_sale_event on public.sale_events;
create trigger trg_notify_on_sale_event
after insert on public.sale_events
for each row execute function public.notify_on_sale_event();
