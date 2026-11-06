-- Phase 10 v1: time-off create RPC (atomic emit) + review emit

create or replace function public.create_staff_time_off_request(
  p_business_id uuid,
  p_membership_id uuid,
  p_location_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_timezone text,
  p_is_full_day boolean,
  p_category public.time_off_category,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_caller public.business_members%rowtype;
  v_target public.business_members%rowtype;
  v_row public.staff_time_off%rowtype;
  v_payload jsonb;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_caller
  from public.business_members
  where business_id = p_business_id
    and user_id = v_user
    and membership_status = 'active'
    and deactivated_at is null;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_target from public.business_members where id = p_membership_id;
  if not found or v_target.business_id is distinct from p_business_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_target.id is distinct from v_caller.id
     and v_caller.role not in ('owner', 'manager')
  then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'VALIDATION_ERROR' using errcode = '22023';
  end if;

  insert into public.staff_time_off (
    business_id, membership_id, location_id, starts_at, ends_at, timezone,
    is_full_day, category, reason, status, requested_by
  ) values (
    p_business_id, p_membership_id, p_location_id, p_starts_at, p_ends_at, p_timezone,
    coalesce(p_is_full_day, true), coalesce(p_category, 'other'), nullif(trim(p_reason), ''),
    'pending', v_user
  )
  returning * into v_row;

  v_payload := jsonb_build_object(
    'title', 'Time off requested',
    'body', 'A time-off request is pending review',
    'href', '/workspace/' || p_business_id::text || '?tab=schedule',
    'timeOffId', v_row.id,
    'requesterUserId', v_user,
    'startsAt', v_row.starts_at,
    'endsAt', v_row.ends_at,
    'timezone', v_row.timezone
  );

  perform public.emit_notification_event(
    p_business_id,
    'time_off.requested',
    'time_off',
    v_row.id,
    'time_off.requested:' || v_row.id::text,
    v_payload,
    v_user
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.create_staff_time_off_request(
  uuid, uuid, uuid, timestamptz, timestamptz, text, boolean, public.time_off_category, text
) from public;
revoke all on function public.create_staff_time_off_request(
  uuid, uuid, uuid, timestamptz, timestamptz, text, boolean, public.time_off_category, text
) from anon;
grant execute on function public.create_staff_time_off_request(
  uuid, uuid, uuid, timestamptz, timestamptz, text, boolean, public.time_off_category, text
) to authenticated;

create or replace function public.review_staff_time_off(
  p_time_off_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_time_off%rowtype;
  v_event_type text;
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into v_row from public.staff_time_off where id = p_time_off_id for update;
  if v_row.id is null then
    raise exception 'TIME_OFF_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_business_schedule_editor(v_row.business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_row.requested_by = auth.uid() then
    raise exception 'CANNOT_REVIEW_OWN_TIME_OFF' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'TIME_OFF_NOT_PENDING' using errcode = '22023';
  end if;
  if p_action not in ('approve', 'reject') then
    raise exception 'INVALID_ACTION' using errcode = '22023';
  end if;

  update public.staff_time_off
  set status = case when p_action = 'approve' then 'approved'::public.time_off_status else 'rejected'::public.time_off_status end,
      reviewed_by = auth.uid(),
      reviewed_at = timezone('utc', now())
  where id = p_time_off_id
  returning * into v_row;

  v_event_type := case when p_action = 'approve' then 'time_off.approved' else 'time_off.rejected' end;
  v_payload := jsonb_build_object(
    'title', case when p_action = 'approve' then 'Time off approved' else 'Time off rejected' end,
    'body', 'Your time-off request was ' || p_action || 'd',
    'href', '/workspace/' || v_row.business_id::text || '?tab=schedule',
    'timeOffId', v_row.id,
    'requesterUserId', v_row.requested_by,
    'startsAt', v_row.starts_at,
    'endsAt', v_row.ends_at,
    'timezone', v_row.timezone
  );

  perform public.emit_notification_event(
    v_row.business_id,
    v_event_type,
    'time_off',
    v_row.id,
    v_event_type || ':' || v_row.id::text,
    v_payload,
    auth.uid()
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.review_staff_time_off(uuid, text) from public;
revoke all on function public.review_staff_time_off(uuid, text) from anon;
grant execute on function public.review_staff_time_off(uuid, text) to authenticated;
