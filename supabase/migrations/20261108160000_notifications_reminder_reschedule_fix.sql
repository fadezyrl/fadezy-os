-- Phase 10: allow reminder re-schedule after cancel when starts_at returns (A→B→A)

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
