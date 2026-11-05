-- Phase 06: Working hours & staff availability foundations
-- Recurring schedules store local wall-clock minutes (overnight: end_minute > 1440).
-- Dated events use timestamptz + explicit timezone. No booking/slots.

-- ---------------------------------------------------------------------------
-- Location hours mode
-- ---------------------------------------------------------------------------
alter table public.business_locations
  add column if not exists hours_mode text not null default 'inherit';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_locations_hours_mode_check'
  ) then
    alter table public.business_locations
      add constraint business_locations_hours_mode_check
      check (hours_mode in ('inherit', 'custom'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'schedule_exception_kind') then
    create type public.schedule_exception_kind as enum ('closed', 'special_hours');
  end if;
  if not exists (select 1 from pg_type where typname = 'time_off_status') then
    create type public.time_off_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'time_off_category') then
    create type public.time_off_category as enum ('vacation', 'sick', 'personal', 'other');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Business weekly hours (template)
-- ---------------------------------------------------------------------------
create table if not exists public.business_weekly_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_minute integer not null check (start_minute >= 0 and start_minute < 1440),
  end_minute integer not null check (end_minute > 0 and end_minute <= 2880),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint business_weekly_hours_range check (
    end_minute > start_minute and (end_minute - start_minute) <= 1440
  )
);

create index if not exists business_weekly_hours_business_idx
  on public.business_weekly_hours (business_id, weekday, sort_order);

drop trigger if exists trg_business_weekly_hours_updated_at on public.business_weekly_hours;
create trigger trg_business_weekly_hours_updated_at
before update on public.business_weekly_hours
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- Location weekly hours (custom mode)
-- ---------------------------------------------------------------------------
create table if not exists public.location_weekly_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_minute integer not null check (start_minute >= 0 and start_minute < 1440),
  end_minute integer not null check (end_minute > 0 and end_minute <= 2880),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint location_weekly_hours_range check (
    end_minute > start_minute and (end_minute - start_minute) <= 1440
  )
);

create index if not exists location_weekly_hours_location_idx
  on public.location_weekly_hours (location_id, weekday, sort_order);

drop trigger if exists trg_location_weekly_hours_updated_at on public.location_weekly_hours;
create trigger trg_location_weekly_hours_updated_at
before update on public.location_weekly_hours
for each row execute function public.set_updated_at_timestamp();

create or replace function public.enforce_location_weekly_hours_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_business uuid;
begin
  select business_id into v_business from public.business_locations where id = new.location_id;
  if v_business is null or v_business <> new.business_id then
    raise exception 'LOCATION_BUSINESS_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_location_weekly_hours_same_business on public.location_weekly_hours;
create trigger trg_location_weekly_hours_same_business
before insert or update on public.location_weekly_hours
for each row execute function public.enforce_location_weekly_hours_same_business();

-- ---------------------------------------------------------------------------
-- Date exceptions (business or location scope)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_date_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid references public.business_locations (id) on delete cascade,
  exception_date date not null,
  kind public.schedule_exception_kind not null,
  label text,
  intervals jsonb not null default '[]'::jsonb,
  cancelled_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint schedule_date_exceptions_label_len check (label is null or char_length(label) <= 120)
);

create index if not exists schedule_date_exceptions_lookup_idx
  on public.schedule_date_exceptions (business_id, location_id, exception_date)
  where cancelled_at is null;

drop trigger if exists trg_schedule_date_exceptions_updated_at on public.schedule_date_exceptions;
create trigger trg_schedule_date_exceptions_updated_at
before update on public.schedule_date_exceptions
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- Staff weekly schedules (versioned)
-- ---------------------------------------------------------------------------
create table if not exists public.staff_weekly_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  effective_from date not null,
  effective_to date,
  superseded_at timestamptz,
  label text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint staff_weekly_schedules_range check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists staff_weekly_schedules_member_idx
  on public.staff_weekly_schedules (membership_id, effective_from desc);

drop trigger if exists trg_staff_weekly_schedules_updated_at on public.staff_weekly_schedules;
create trigger trg_staff_weekly_schedules_updated_at
before update on public.staff_weekly_schedules
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.staff_weekly_intervals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  schedule_id uuid not null references public.staff_weekly_schedules (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_minute integer not null check (start_minute >= 0 and start_minute < 1440),
  end_minute integer not null check (end_minute > 0 and end_minute <= 2880),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  constraint staff_weekly_intervals_range check (
    end_minute > start_minute and (end_minute - start_minute) <= 1440
  )
);

create index if not exists staff_weekly_intervals_schedule_idx
  on public.staff_weekly_intervals (schedule_id, weekday, location_id);

create table if not exists public.staff_weekly_breaks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  schedule_id uuid not null references public.staff_weekly_schedules (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_minute integer not null check (start_minute >= 0 and start_minute < 1440),
  end_minute integer not null check (end_minute > 0 and end_minute <= 2880),
  is_paid boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  constraint staff_weekly_breaks_range check (
    end_minute > start_minute and (end_minute - start_minute) <= 1440
  )
);

create index if not exists staff_weekly_breaks_schedule_idx
  on public.staff_weekly_breaks (schedule_id, weekday);

-- ---------------------------------------------------------------------------
-- Staff time off
-- ---------------------------------------------------------------------------
create table if not exists public.staff_time_off (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  location_id uuid references public.business_locations (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 64),
  is_full_day boolean not null default true,
  category public.time_off_category not null default 'other',
  reason text,
  status public.time_off_status not null default 'pending',
  requested_by uuid not null references auth.users (id) on delete restrict,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint staff_time_off_range check (ends_at > starts_at),
  constraint staff_time_off_reason_len check (reason is null or char_length(reason) <= 500)
);

create index if not exists staff_time_off_member_idx
  on public.staff_time_off (membership_id, starts_at, ends_at);

create index if not exists staff_time_off_business_status_idx
  on public.staff_time_off (business_id, status, starts_at);

drop trigger if exists trg_staff_time_off_updated_at on public.staff_time_off;
create trigger trg_staff_time_off_updated_at
before update on public.staff_time_off
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_business_schedule_editor(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = auth.uid()
      and bm.membership_status = 'active'
      and bm.deactivated_at is null
      and bm.role in ('owner', 'manager')
  );
$$;

revoke all on function public.is_business_schedule_editor(uuid) from public;
grant execute on function public.is_business_schedule_editor(uuid) to authenticated;

create or replace function public.copy_business_hours_to_location(p_location_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
begin
  select business_id into v_business_id from public.business_locations where id = p_location_id;
  if v_business_id is null then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.location_weekly_hours where location_id = p_location_id;

  insert into public.location_weekly_hours (
    business_id, location_id, weekday, start_minute, end_minute, sort_order
  )
  select business_id, p_location_id, weekday, start_minute, end_minute, sort_order
  from public.business_weekly_hours
  where business_id = v_business_id;
end;
$$;

revoke all on function public.copy_business_hours_to_location(uuid) from public;
grant execute on function public.copy_business_hours_to_location(uuid) to authenticated;

-- After location insert: seed custom copy from business template (hours_mode stays inherit until customized)
create or replace function public.trg_location_seed_hours()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.copy_business_hours_to_location(new.id);
  return new;
end;
$$;

drop trigger if exists trg_location_seed_hours on public.business_locations;
create trigger trg_location_seed_hours
after insert on public.business_locations
for each row execute function public.trg_location_seed_hours();

-- ---------------------------------------------------------------------------
-- RPCs: replace weekly hours sets
-- ---------------------------------------------------------------------------
create or replace function public.replace_business_weekly_hours(
  p_business_id uuid,
  p_intervals jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_start integer;
  v_end integer;
  v_weekday integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_business_schedule_editor(p_business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if jsonb_typeof(p_intervals) <> 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_intervals)
  loop
    v_weekday := (v_item->>'weekday')::integer;
    v_start := (v_item->>'start_minute')::integer;
    v_end := (v_item->>'end_minute')::integer;
    if v_weekday is null or v_weekday < 1 or v_weekday > 7 then
      raise exception 'INVALID_WEEKDAY' using errcode = '22023';
    end if;
    if v_start is null or v_end is null or v_end <= v_start or v_start < 0 or v_start >= 1440 or (v_end - v_start) > 1440 then
      raise exception 'INVALID_INTERVAL' using errcode = '22023';
    end if;
  end loop;

  -- overlap check within weekday
  if exists (
    select 1
    from jsonb_array_elements(p_intervals) a
    join jsonb_array_elements(p_intervals) b on true
    where (a->>'weekday')::int = (b->>'weekday')::int
      and a <> b
      and (a->>'start_minute')::int < (b->>'end_minute')::int
      and (b->>'start_minute')::int < (a->>'end_minute')::int
  ) then
    raise exception 'OVERLAPPING_INTERVALS' using errcode = '22023';
  end if;

  delete from public.business_weekly_hours where business_id = p_business_id;

  insert into public.business_weekly_hours (business_id, weekday, start_minute, end_minute, sort_order)
  select
    p_business_id,
    (item->>'weekday')::smallint,
    (item->>'start_minute')::integer,
    (item->>'end_minute')::integer,
    coalesce((item->>'sort_order')::integer, 0)
  from jsonb_array_elements(p_intervals) item;

  return coalesce((
    select jsonb_agg(to_jsonb(h) order by h.weekday, h.sort_order, h.start_minute)
    from public.business_weekly_hours h
    where h.business_id = p_business_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.replace_business_weekly_hours(uuid, jsonb) from public;
grant execute on function public.replace_business_weekly_hours(uuid, jsonb) to authenticated;

create or replace function public.replace_location_weekly_hours(
  p_location_id uuid,
  p_hours_mode text,
  p_intervals jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_item jsonb;
  v_start integer;
  v_end integer;
  v_weekday integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select business_id into v_business_id from public.business_locations where id = p_location_id;
  if v_business_id is null then
    raise exception 'LOCATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_business_schedule_editor(v_business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_hours_mode not in ('inherit', 'custom') then
    raise exception 'INVALID_HOURS_MODE' using errcode = '22023';
  end if;

  update public.business_locations
  set hours_mode = p_hours_mode
  where id = p_location_id;

  if p_hours_mode = 'inherit' then
    perform public.copy_business_hours_to_location(p_location_id);
  else
    if jsonb_typeof(p_intervals) <> 'array' then
      raise exception 'INVALID_PAYLOAD' using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_intervals)
    loop
      v_weekday := (v_item->>'weekday')::integer;
      v_start := (v_item->>'start_minute')::integer;
      v_end := (v_item->>'end_minute')::integer;
      if v_weekday is null or v_weekday < 1 or v_weekday > 7 then
        raise exception 'INVALID_WEEKDAY' using errcode = '22023';
      end if;
      if v_start is null or v_end is null or v_end <= v_start or v_start < 0 or v_start >= 1440 or (v_end - v_start) > 1440 then
        raise exception 'INVALID_INTERVAL' using errcode = '22023';
      end if;
    end loop;
    if exists (
      select 1
      from jsonb_array_elements(p_intervals) a
      join jsonb_array_elements(p_intervals) b on true
      where (a->>'weekday')::int = (b->>'weekday')::int
        and a <> b
        and (a->>'start_minute')::int < (b->>'end_minute')::int
        and (b->>'start_minute')::int < (a->>'end_minute')::int
    ) then
      raise exception 'OVERLAPPING_INTERVALS' using errcode = '22023';
    end if;

    delete from public.location_weekly_hours where location_id = p_location_id;
    insert into public.location_weekly_hours (
      business_id, location_id, weekday, start_minute, end_minute, sort_order
    )
    select
      v_business_id,
      p_location_id,
      (item->>'weekday')::smallint,
      (item->>'start_minute')::integer,
      (item->>'end_minute')::integer,
      coalesce((item->>'sort_order')::integer, 0)
    from jsonb_array_elements(p_intervals) item;
  end if;

  return jsonb_build_object(
    'location_id', p_location_id,
    'hours_mode', p_hours_mode,
    'intervals', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.weekday, h.sort_order, h.start_minute)
      from public.location_weekly_hours h
      where h.location_id = p_location_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.replace_location_weekly_hours(uuid, text, jsonb) from public;
grant execute on function public.replace_location_weekly_hours(uuid, text, jsonb) to authenticated;

create or replace function public.create_schedule_date_exception(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid := (payload->>'business_id')::uuid;
  v_location_id uuid := nullif(payload->>'location_id', '')::uuid;
  v_kind public.schedule_exception_kind := (payload->>'kind')::public.schedule_exception_kind;
  v_row public.schedule_date_exceptions%rowtype;
  v_loc_business uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_business_id is null then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;
  if not public.is_business_schedule_editor(v_business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_location_id is not null then
    select business_id into v_loc_business from public.business_locations where id = v_location_id;
    if v_loc_business is distinct from v_business_id then
      raise exception 'LOCATION_BUSINESS_MISMATCH' using errcode = '23514';
    end if;
  end if;

  insert into public.schedule_date_exceptions (
    business_id, location_id, exception_date, kind, label, intervals, created_by
  )
  values (
    v_business_id,
    v_location_id,
    (payload->>'exception_date')::date,
    v_kind,
    nullif(trim(payload->>'label'), ''),
    coalesce(payload->'intervals', '[]'::jsonb),
    auth.uid()
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.create_schedule_date_exception(jsonb) from public;
grant execute on function public.create_schedule_date_exception(jsonb) to authenticated;

create or replace function public.cancel_schedule_date_exception(p_exception_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.schedule_date_exceptions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into v_row from public.schedule_date_exceptions where id = p_exception_id;
  if v_row.id is null then
    raise exception 'EXCEPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_business_schedule_editor(v_row.business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.schedule_date_exceptions
  set cancelled_at = timezone('utc', now())
  where id = p_exception_id
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.cancel_schedule_date_exception(uuid) from public;
grant execute on function public.cancel_schedule_date_exception(uuid) to authenticated;

create or replace function public.replace_staff_weekly_schedule(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid := (payload->>'business_id')::uuid;
  v_membership_id uuid := (payload->>'membership_id')::uuid;
  v_effective_from date := (payload->>'effective_from')::date;
  v_schedule public.staff_weekly_schedules%rowtype;
  v_interval jsonb;
  v_break jsonb;
  v_location_id uuid;
  v_assign_count integer;
  v_weekday integer;
  v_start integer;
  v_end integer;
  v_member public.business_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_business_schedule_editor(v_business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_member from public.business_members where id = v_membership_id;
  if v_member.id is null or v_member.business_id <> v_business_id then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_assign_count
  from public.staff_location_assignments
  where membership_id = v_membership_id;

  -- Close current open versions
  update public.staff_weekly_schedules
  set effective_to = greatest(effective_from, v_effective_from - 1),
      superseded_at = timezone('utc', now())
  where membership_id = v_membership_id
    and superseded_at is null
    and (effective_to is null or effective_to >= v_effective_from);

  insert into public.staff_weekly_schedules (
    business_id, membership_id, effective_from, label, created_by
  )
  values (
    v_business_id,
    v_membership_id,
    v_effective_from,
    nullif(trim(payload->>'label'), ''),
    auth.uid()
  )
  returning * into v_schedule;

  for v_interval in select * from jsonb_array_elements(coalesce(payload->'intervals', '[]'::jsonb))
  loop
    v_location_id := (v_interval->>'location_id')::uuid;
    v_weekday := (v_interval->>'weekday')::integer;
    v_start := (v_interval->>'start_minute')::integer;
    v_end := (v_interval->>'end_minute')::integer;

    if v_location_id is null then
      raise exception 'LOCATION_REQUIRED' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.staff_location_assignments
      where membership_id = v_membership_id and location_id = v_location_id
    ) then
      -- Allow first schedule setup when staff has zero assignments only if single location business?
      -- Spec: enforce staff-location assignments. Require assignment.
      raise exception 'LOCATION_NOT_ASSIGNED' using errcode = '22023';
    end if;
    if v_assign_count > 1 and v_location_id is null then
      raise exception 'LOCATION_REQUIRED' using errcode = '22023';
    end if;
    if v_end <= v_start or v_start < 0 or v_start >= 1440 or (v_end - v_start) > 1440 then
      raise exception 'INVALID_INTERVAL' using errcode = '22023';
    end if;

    insert into public.staff_weekly_intervals (
      business_id, schedule_id, membership_id, location_id, weekday, start_minute, end_minute, sort_order
    ) values (
      v_business_id, v_schedule.id, v_membership_id, v_location_id, v_weekday, v_start, v_end,
      coalesce((v_interval->>'sort_order')::integer, 0)
    );
  end loop;

  -- Overlap per weekday+location
  if exists (
    select 1
    from public.staff_weekly_intervals a
    join public.staff_weekly_intervals b
      on a.schedule_id = b.schedule_id
     and a.weekday = b.weekday
     and a.location_id = b.location_id
     and a.id < b.id
     and a.start_minute < b.end_minute
     and b.start_minute < a.end_minute
    where a.schedule_id = v_schedule.id
  ) then
    raise exception 'OVERLAPPING_INTERVALS' using errcode = '22023';
  end if;

  for v_break in select * from jsonb_array_elements(coalesce(payload->'breaks', '[]'::jsonb))
  loop
    v_weekday := (v_break->>'weekday')::integer;
    v_start := (v_break->>'start_minute')::integer;
    v_end := (v_break->>'end_minute')::integer;
    if not exists (
      select 1 from public.staff_weekly_intervals i
      where i.schedule_id = v_schedule.id
        and i.weekday = v_weekday
        and v_start >= i.start_minute
        and v_end <= i.end_minute
    ) then
      raise exception 'BREAK_OUTSIDE_INTERVAL' using errcode = '22023';
    end if;
    insert into public.staff_weekly_breaks (
      business_id, schedule_id, membership_id, weekday, start_minute, end_minute, is_paid, sort_order
    ) values (
      v_business_id, v_schedule.id, v_membership_id, v_weekday, v_start, v_end,
      coalesce((v_break->>'is_paid')::boolean, false),
      coalesce((v_break->>'sort_order')::integer, 0)
    );
  end loop;

  return to_jsonb(v_schedule);
end;
$$;

revoke all on function public.replace_staff_weekly_schedule(jsonb) from public;
grant execute on function public.replace_staff_weekly_schedule(jsonb) to authenticated;

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
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into v_row from public.staff_time_off where id = p_time_off_id;
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

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.review_staff_time_off(uuid, text) from public;
grant execute on function public.review_staff_time_off(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.business_weekly_hours enable row level security;
alter table public.location_weekly_hours enable row level security;
alter table public.schedule_date_exceptions enable row level security;
alter table public.staff_weekly_schedules enable row level security;
alter table public.staff_weekly_intervals enable row level security;
alter table public.staff_weekly_breaks enable row level security;
alter table public.staff_time_off enable row level security;

drop policy if exists business_weekly_hours_select_member on public.business_weekly_hours;
create policy business_weekly_hours_select_member
  on public.business_weekly_hours for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists location_weekly_hours_select_member on public.location_weekly_hours;
create policy location_weekly_hours_select_member
  on public.location_weekly_hours for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists schedule_date_exceptions_select_member on public.schedule_date_exceptions;
create policy schedule_date_exceptions_select_member
  on public.schedule_date_exceptions for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists staff_weekly_schedules_select on public.staff_weekly_schedules;
create policy staff_weekly_schedules_select
  on public.staff_weekly_schedules for select to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or membership_id in (
      select id from public.business_members
      where user_id = auth.uid() and business_id = staff_weekly_schedules.business_id
    )
  );

drop policy if exists staff_weekly_intervals_select on public.staff_weekly_intervals;
create policy staff_weekly_intervals_select
  on public.staff_weekly_intervals for select to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or membership_id in (
      select id from public.business_members
      where user_id = auth.uid() and business_id = staff_weekly_intervals.business_id
    )
  );

drop policy if exists staff_weekly_breaks_select on public.staff_weekly_breaks;
create policy staff_weekly_breaks_select
  on public.staff_weekly_breaks for select to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or membership_id in (
      select id from public.business_members
      where user_id = auth.uid() and business_id = staff_weekly_breaks.business_id
    )
  );

drop policy if exists staff_time_off_select on public.staff_time_off;
create policy staff_time_off_select
  on public.staff_time_off for select to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or membership_id in (
      select id from public.business_members
      where user_id = auth.uid() and business_id = staff_time_off.business_id
    )
  );

drop policy if exists staff_time_off_insert_self on public.staff_time_off;
create policy staff_time_off_insert_self
  on public.staff_time_off for insert to authenticated
  with check (
    public.is_business_member(business_id)
    and requested_by = auth.uid()
    and membership_id in (
      select id from public.business_members
      where user_id = auth.uid() and business_id = staff_time_off.business_id
        and membership_status = 'active' and deactivated_at is null
    )
  );

drop policy if exists staff_time_off_update_self_or_editor on public.staff_time_off;
create policy staff_time_off_update_self_or_editor
  on public.staff_time_off for update to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or (
      requested_by = auth.uid()
      and status = 'pending'
    )
  )
  with check (
    public.is_business_schedule_editor(business_id)
    or requested_by = auth.uid()
  );

-- Mutations primarily via SECURITY DEFINER RPCs
revoke all on table public.business_weekly_hours from anon;
revoke all on table public.location_weekly_hours from anon;
revoke all on table public.schedule_date_exceptions from anon;
revoke all on table public.staff_weekly_schedules from anon;
revoke all on table public.staff_weekly_intervals from anon;
revoke all on table public.staff_weekly_breaks from anon;
revoke all on table public.staff_time_off from anon;

grant select on table public.business_weekly_hours to authenticated;
grant select on table public.location_weekly_hours to authenticated;
grant select on table public.schedule_date_exceptions to authenticated;
grant select on table public.staff_weekly_schedules to authenticated;
grant select on table public.staff_weekly_intervals to authenticated;
grant select on table public.staff_weekly_breaks to authenticated;
grant select, insert, update on table public.staff_time_off to authenticated;
