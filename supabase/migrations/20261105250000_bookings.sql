-- Phase 07: Booking engine foundations
-- One primary service + optional add-ons. Explicit staff. Confirmed on create.
-- Busy range = [starts_at - buffer_before, ends_at + buffer_after) with GiST exclusion.

create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type public.booking_status as enum ('confirmed', 'completed', 'cancelled', 'no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_channel') then
    create type public.booking_channel as enum ('workspace', 'online');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Customers (minimal, no auth.users link)
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint customers_full_name_len check (char_length(trim(full_name)) between 1 and 120),
  constraint customers_email_len check (email is null or char_length(email) <= 320),
  constraint customers_phone_len check (phone is null or char_length(phone) <= 32),
  constraint customers_notes_len check (notes is null or char_length(notes) <= 2000)
);

create index if not exists customers_business_name_idx
  on public.customers (business_id, lower(full_name));
create index if not exists customers_business_email_idx
  on public.customers (business_id, lower(email))
  where email is not null;

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
before update on public.customers
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  staff_membership_id uuid not null references public.business_members (id) on delete restrict,
  status public.booking_status not null default 'confirmed',
  channel public.booking_channel not null default 'workspace',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  busy_starts_at timestamptz not null,
  busy_ends_at timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 64),
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes >= 0),
  buffer_after_minutes integer not null default 0 check (buffer_after_minutes >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  total_price_minor bigint not null check (total_price_minor >= 0),
  customer_name text not null,
  customer_email text,
  customer_phone text,
  location_name text not null,
  staff_display_name text not null,
  reference_code text not null,
  idempotency_key text not null,
  idempotency_payload_hash text not null,
  notes text,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint bookings_time_order check (ends_at > starts_at),
  constraint bookings_busy_order check (busy_ends_at > busy_starts_at),
  constraint bookings_busy_covers check (
    busy_starts_at <= starts_at and busy_ends_at >= ends_at
  ),
  constraint bookings_reference_unique unique (business_id, reference_code),
  constraint bookings_idempotency_unique unique (business_id, idempotency_key)
);

create index if not exists bookings_business_starts_idx
  on public.bookings (business_id, starts_at);
create index if not exists bookings_location_starts_idx
  on public.bookings (location_id, starts_at);
create index if not exists bookings_staff_busy_idx
  on public.bookings (staff_membership_id, busy_starts_at, busy_ends_at);

-- Active occupancy only: confirmed blocks; completed/no_show/cancelled do not.
alter table public.bookings
  drop constraint if exists bookings_staff_busy_excl;

alter table public.bookings
  add constraint bookings_staff_busy_excl
  exclude using gist (
    staff_membership_id with =,
    tstzrange(busy_starts_at, busy_ends_at, '[)') with &&
  )
  where (status = 'confirmed');

drop trigger if exists trg_bookings_updated_at on public.bookings;
create trigger trg_bookings_updated_at
before update on public.bookings
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.booking_services (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  service_name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  processing_minutes integer not null default 0 check (processing_minutes >= 0),
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.booking_addons (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  addon_id uuid references public.service_addons (id) on delete set null,
  addon_name text not null,
  duration_minutes integer not null default 0 check (duration_minutes >= 0),
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.booking_status_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  from_status public.booking_status,
  to_status public.booking_status not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  note text,
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists booking_status_events_booking_idx
  on public.booking_status_events (booking_id, created_at);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_booking_location_manager(
  p_business_id uuid,
  p_location_id uuid
)
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
      and (
        bm.role in ('owner', 'manager')
        or (
          bm.role = 'staff'
          and exists (
            select 1 from public.staff_location_assignments sla
            where sla.membership_id = bm.id and sla.location_id = p_location_id
          )
        )
      )
  );
$$;

revoke all on function public.is_booking_location_manager(uuid, uuid) from public;
grant execute on function public.is_booking_location_manager(uuid, uuid) to authenticated;

create or replace function public.generate_booking_reference(p_business_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_tries integer := 0;
begin
  loop
    v_tries := v_tries + 1;
    v_code := 'BK' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (
      select 1 from public.bookings where business_id = p_business_id and reference_code = v_code
    );
    if v_tries > 20 then
      raise exception 'REFERENCE_GENERATION_FAILED' using errcode = 'P0001';
    end if;
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_services enable row level security;
alter table public.booking_addons enable row level security;
alter table public.booking_status_events enable row level security;

drop policy if exists customers_select_member on public.customers;
create policy customers_select_member
  on public.customers for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists customers_insert_member on public.customers;
create policy customers_insert_member
  on public.customers for insert to authenticated
  with check (public.is_business_member(business_id));

drop policy if exists customers_update_member on public.customers;
create policy customers_update_member
  on public.customers for update to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

drop policy if exists bookings_select_member on public.bookings;
create policy bookings_select_member
  on public.bookings for select to authenticated
  using (
    public.is_business_schedule_editor(business_id)
    or public.is_booking_location_manager(business_id, location_id)
  );

drop policy if exists booking_services_select_member on public.booking_services;
create policy booking_services_select_member
  on public.booking_services for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists booking_addons_select_member on public.booking_addons;
create policy booking_addons_select_member
  on public.booking_addons for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists booking_status_events_select_member on public.booking_status_events;
create policy booking_status_events_select_member
  on public.booking_status_events for select to authenticated
  using (public.is_business_member(business_id));

-- Mutations via SECURITY DEFINER RPCs / controlled service paths
revoke all on table public.customers from anon;
revoke all on table public.bookings from anon;
revoke all on table public.booking_services from anon;
revoke all on table public.booking_addons from anon;
revoke all on table public.booking_status_events from anon;

grant select, insert, update on table public.customers to authenticated;
grant select on table public.bookings to authenticated;
grant select on table public.booking_services to authenticated;
grant select on table public.booking_addons to authenticated;
grant select on table public.booking_status_events to authenticated;

-- Active booking occupancy for a staff member on a day (UTC bounds)
create or replace function public.list_staff_busy_ranges(
  p_staff_membership_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (busy_starts_at timestamptz, busy_ends_at timestamptz, booking_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select b.busy_starts_at, b.busy_ends_at, b.id
  from public.bookings b
  where b.staff_membership_id = p_staff_membership_id
    and b.status = 'confirmed'
    and b.busy_starts_at < p_to
    and b.busy_ends_at > p_from;
$$;

revoke all on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz) from public;
grant execute on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz) to authenticated, anon;

create or replace function public.transition_booking_status(
  p_booking_id uuid,
  p_to_status public.booking_status,
  p_note text default null,
  p_previous_starts_at timestamptz default null,
  p_previous_ends_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.bookings%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_row from public.bookings where id = p_booking_id for update;
  if v_row.id is null then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.is_booking_location_manager(v_row.business_id, v_row.location_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_row.status <> 'confirmed' then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = '22023';
  end if;

  if p_to_status not in ('completed', 'cancelled', 'no_show') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = '22023';
  end if;

  update public.bookings
  set status = p_to_status,
      cancellation_reason = case when p_to_status = 'cancelled' then nullif(trim(p_note), '') else cancellation_reason end,
      cancelled_at = case when p_to_status = 'cancelled' then timezone('utc', now()) else cancelled_at end
  where id = p_booking_id
  returning * into v_row;

  insert into public.booking_status_events (
    booking_id, business_id, from_status, to_status, actor_user_id, note,
    previous_starts_at, previous_ends_at
  ) values (
    v_row.id, v_row.business_id, 'confirmed', p_to_status, v_user, nullif(trim(p_note), ''),
    p_previous_starts_at, p_previous_ends_at
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.transition_booking_status(uuid, public.booking_status, text, timestamptz, timestamptz) from public;
grant execute on function public.transition_booking_status(uuid, public.booking_status, text, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Same-business integrity
-- ---------------------------------------------------------------------------
create or replace function public.enforce_booking_same_business()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc_business uuid;
  v_customer_business uuid;
  v_member_business uuid;
begin
  select business_id into v_loc_business from public.business_locations where id = new.location_id;
  select business_id into v_customer_business from public.customers where id = new.customer_id;
  select business_id into v_member_business from public.business_members where id = new.staff_membership_id;

  if v_loc_business is distinct from new.business_id
     or v_customer_business is distinct from new.business_id
     or v_member_business is distinct from new.business_id then
    raise exception 'BOOKING_BUSINESS_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bookings_same_business on public.bookings;
create trigger trg_bookings_same_business
before insert or update on public.bookings
for each row execute function public.enforce_booking_same_business();

create or replace function public.enforce_booking_line_same_business()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_business uuid;
begin
  select business_id into v_booking_business from public.bookings where id = new.booking_id;
  if v_booking_business is distinct from new.business_id then
    raise exception 'BOOKING_LINE_BUSINESS_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_booking_services_same_business on public.booking_services;
create trigger trg_booking_services_same_business
before insert or update on public.booking_services
for each row execute function public.enforce_booking_line_same_business();

drop trigger if exists trg_booking_addons_same_business on public.booking_addons;
create trigger trg_booking_addons_same_business
before insert or update on public.booking_addons
for each row execute function public.enforce_booking_line_same_business();
