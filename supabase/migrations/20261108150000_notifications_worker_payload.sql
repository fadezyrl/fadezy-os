-- Phase 10 v1: worker payload + skip RPCs (no table DML grants)

create or replace function public.worker_get_delivery_payload(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  select e.payload into v_payload
  from public.notification_deliveries d
  join public.notification_events e on e.id = d.event_id
  where d.id = p_delivery_id
    and d.status = 'processing'
    and d.lease_expires_at is not null
    and d.lease_expires_at > timezone('utc', now());

  if not found then
    raise exception 'DELIVERY_NOT_CLAIMED' using errcode = 'P0002';
  end if;

  return coalesce(v_payload, '{}'::jsonb);
end;
$$;

create or replace function public.skip_notification_delivery(
  p_delivery_id uuid,
  p_reason text
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

revoke all on function public.worker_get_delivery_payload(uuid) from public;
revoke all on function public.worker_get_delivery_payload(uuid) from anon;
revoke all on function public.worker_get_delivery_payload(uuid) from authenticated;
grant execute on function public.worker_get_delivery_payload(uuid) to fadezy_notify_worker;

revoke all on function public.skip_notification_delivery(uuid, text) from public;
revoke all on function public.skip_notification_delivery(uuid, text) from anon;
revoke all on function public.skip_notification_delivery(uuid, text) from authenticated;
grant execute on function public.skip_notification_delivery(uuid, text) to fadezy_notify_worker;
