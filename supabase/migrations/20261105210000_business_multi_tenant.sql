-- Phase 03: multi-tenant business foundation
-- Owner identity is always derived from auth.uid() inside RPC. Never from client payload.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'business_type') then
    create type public.business_type as enum ('barbershop', 'beauty_salon');
  end if;
  if not exists (select 1 from pg_type where typname = 'business_role') then
    create type public.business_role as enum ('owner', 'manager', 'staff');
  end if;
  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type public.membership_status as enum ('active', 'invited', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'onboarding_status') then
    create type public.onboarding_status as enum ('not_started', 'in_progress', 'completed');
  end if;
  if not exists (select 1 from pg_type where typname = 'location_type') then
    create type public.location_type as enum ('salon', 'studio', 'mobile', 'other');
  end if;
end $$;

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null,
  business_type public.business_type not null,
  legal_name text check (legal_name is null or char_length(legal_name) <= 160),
  description text check (description is null or char_length(description) <= 2000),
  email text check (email is null or char_length(email) <= 320),
  phone text check (phone is null or char_length(phone) <= 32),
  website_url text check (website_url is null or char_length(website_url) <= 2048),
  logo_url text check (logo_url is null or char_length(logo_url) <= 2048),
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  default_currency char(3) not null check (default_currency ~ '^[A-Z]{3}$'),
  timezone text not null check (char_length(timezone) between 1 and 64),
  default_locale text not null check (char_length(default_locale) between 2 and 35),
  onboarding_status public.onboarding_status not null default 'in_progress',
  client_request_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint businesses_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint businesses_slug_unique unique (slug),
  constraint businesses_client_request_unique unique (client_request_id)
);

create index if not exists businesses_country_code_idx on public.businesses (country_code);
create index if not exists businesses_onboarding_status_idx on public.businesses (onboarding_status);
create index if not exists businesses_created_at_idx on public.businesses (created_at desc);

create table if not exists public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.business_role not null,
  membership_status public.membership_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint business_members_business_user_unique unique (business_id, user_id)
);

create index if not exists business_members_user_id_idx on public.business_members (user_id);
create index if not exists business_members_business_id_idx on public.business_members (business_id);

create table if not exists public.business_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  location_type public.location_type not null default 'salon',
  address_line_1 text check (address_line_1 is null or char_length(address_line_1) <= 180),
  address_line_2 text check (address_line_2 is null or char_length(address_line_2) <= 180),
  city text not null check (char_length(trim(city)) between 1 and 120),
  state_region text check (state_region is null or char_length(state_region) <= 120),
  postal_code text check (postal_code is null or char_length(postal_code) <= 32),
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  phone text check (phone is null or char_length(phone) <= 32),
  email text check (email is null or char_length(email) <= 320),
  timezone text not null check (char_length(timezone) between 1 and 64),
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists business_locations_business_id_idx
  on public.business_locations (business_id);

create unique index if not exists business_locations_one_primary_idx
  on public.business_locations (business_id)
  where is_primary = true;

create table if not exists public.business_onboarding_drafts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  draft jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_businesses_updated_at on public.businesses;
create trigger trg_businesses_updated_at
before update on public.businesses
for each row execute function public.set_updated_at_timestamp();

drop trigger if exists trg_business_members_updated_at on public.business_members;
create trigger trg_business_members_updated_at
before update on public.business_members
for each row execute function public.set_updated_at_timestamp();

drop trigger if exists trg_business_locations_updated_at on public.business_locations;
create trigger trg_business_locations_updated_at
before update on public.business_locations
for each row execute function public.set_updated_at_timestamp();

drop trigger if exists trg_business_onboarding_drafts_updated_at on public.business_onboarding_drafts;
create trigger trg_business_onboarding_drafts_updated_at
before update on public.business_onboarding_drafts
for each row execute function public.set_updated_at_timestamp();

-- Membership helpers used by RLS (security definer, locked search_path).
create or replace function public.is_business_member(p_business_id uuid)
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
  );
$$;

create or replace function public.is_business_owner(p_business_id uuid)
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
      and bm.role = 'owner'
      and bm.membership_status = 'active'
  );
$$;

revoke all on function public.is_business_member(uuid) from public;
revoke all on function public.is_business_owner(uuid) from public;
grant execute on function public.is_business_member(uuid) to authenticated;
grant execute on function public.is_business_owner(uuid) to authenticated;

-- Atomic business creation. Owner is ALWAYS auth.uid().
create or replace function public.create_business_with_owner(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_business public.businesses%rowtype;
  v_member public.business_members%rowtype;
  v_location public.business_locations%rowtype;
  v_client_request_id uuid;
  v_existing_id uuid;
  v_location_json jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if payload is null then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  v_client_request_id := nullif(payload->>'client_request_id', '')::uuid;
  if v_client_request_id is not null then
    select id into v_existing_id
    from public.businesses
    where client_request_id = v_client_request_id;

    if v_existing_id is not null then
      select * into v_business from public.businesses where id = v_existing_id;
      select * into v_member
      from public.business_members
      where business_id = v_existing_id and user_id = v_user_id;
      select * into v_location
      from public.business_locations
      where business_id = v_existing_id and is_primary = true
      limit 1;

      return jsonb_build_object(
        'business', to_jsonb(v_business),
        'membership', to_jsonb(v_member),
        'primary_location', to_jsonb(v_location),
        'idempotent_replay', true
      );
    end if;
  end if;

  v_location_json := payload->'primary_location';
  if v_location_json is null or jsonb_typeof(v_location_json) <> 'object' then
    raise exception 'PRIMARY_LOCATION_REQUIRED' using errcode = '22023';
  end if;

  insert into public.businesses (
    name,
    slug,
    business_type,
    legal_name,
    description,
    email,
    phone,
    website_url,
    country_code,
    default_currency,
    timezone,
    default_locale,
    onboarding_status,
    client_request_id
  )
  values (
    nullif(trim(payload->>'name'), ''),
    lower(nullif(trim(payload->>'slug'), '')),
    (payload->>'business_type')::public.business_type,
    nullif(trim(payload->>'legal_name'), ''),
    nullif(trim(payload->>'description'), ''),
    nullif(trim(payload->>'email'), ''),
    nullif(trim(payload->>'phone'), ''),
    nullif(trim(payload->>'website_url'), ''),
    upper(nullif(trim(payload->>'country_code'), '')),
    upper(nullif(trim(payload->>'default_currency'), '')),
    nullif(trim(payload->>'timezone'), ''),
    nullif(trim(payload->>'default_locale'), ''),
    'completed',
    v_client_request_id
  )
  returning * into v_business;

  insert into public.business_members (
    business_id,
    user_id,
    role,
    membership_status
  )
  values (
    v_business.id,
    v_user_id,
    'owner',
    'active'
  )
  returning * into v_member;

  insert into public.business_locations (
    business_id,
    name,
    location_type,
    address_line_1,
    address_line_2,
    city,
    state_region,
    postal_code,
    country_code,
    phone,
    email,
    timezone,
    is_primary,
    is_active
  )
  values (
    v_business.id,
    nullif(trim(v_location_json->>'name'), ''),
    coalesce((v_location_json->>'location_type')::public.location_type, 'salon'),
    nullif(trim(v_location_json->>'address_line_1'), ''),
    nullif(trim(v_location_json->>'address_line_2'), ''),
    nullif(trim(v_location_json->>'city'), ''),
    nullif(trim(v_location_json->>'state_region'), ''),
    nullif(trim(v_location_json->>'postal_code'), ''),
    upper(nullif(trim(v_location_json->>'country_code'), '')),
    nullif(trim(v_location_json->>'phone'), ''),
    nullif(trim(v_location_json->>'email'), ''),
    nullif(trim(v_location_json->>'timezone'), ''),
    true,
    true
  )
  returning * into v_location;

  delete from public.business_onboarding_drafts where user_id = v_user_id;

  return jsonb_build_object(
    'business', to_jsonb(v_business),
    'membership', to_jsonb(v_member),
    'primary_location', to_jsonb(v_location),
    'idempotent_replay', false
  );
exception
  when unique_violation then
    raise exception 'SLUG_OR_REQUEST_CONFLICT' using errcode = '23505';
end;
$$;

revoke all on function public.create_business_with_owner(jsonb) from public;
grant execute on function public.create_business_with_owner(jsonb) to authenticated;

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.business_locations enable row level security;
alter table public.business_onboarding_drafts enable row level security;

-- businesses policies
drop policy if exists businesses_select_member on public.businesses;
create policy businesses_select_member
  on public.businesses
  for select
  to authenticated
  using (public.is_business_member(id));

drop policy if exists businesses_update_owner on public.businesses;
create policy businesses_update_owner
  on public.businesses
  for update
  to authenticated
  using (public.is_business_owner(id))
  with check (public.is_business_owner(id));

-- No direct insert/delete for clients. Creation goes through RPC.
drop policy if exists businesses_insert_none on public.businesses;
drop policy if exists businesses_delete_none on public.businesses;

-- business_members policies
drop policy if exists business_members_select_member on public.business_members;
create policy business_members_select_member
  on public.business_members
  for select
  to authenticated
  using (public.is_business_member(business_id));

-- No insert/update/delete via ordinary clients (prevents role escalation).
-- Owner assignment happens only inside create_business_with_owner.

-- business_locations policies
drop policy if exists business_locations_select_member on public.business_locations;
create policy business_locations_select_member
  on public.business_locations
  for select
  to authenticated
  using (public.is_business_member(business_id));

drop policy if exists business_locations_insert_owner on public.business_locations;
create policy business_locations_insert_owner
  on public.business_locations
  for insert
  to authenticated
  with check (public.is_business_owner(business_id));

drop policy if exists business_locations_update_owner on public.business_locations;
create policy business_locations_update_owner
  on public.business_locations
  for update
  to authenticated
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

-- drafts: own row only
drop policy if exists drafts_select_own on public.business_onboarding_drafts;
create policy drafts_select_own
  on public.business_onboarding_drafts
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists drafts_insert_own on public.business_onboarding_drafts;
create policy drafts_insert_own
  on public.business_onboarding_drafts
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists drafts_update_own on public.business_onboarding_drafts;
create policy drafts_update_own
  on public.business_onboarding_drafts
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists drafts_delete_own on public.business_onboarding_drafts;
create policy drafts_delete_own
  on public.business_onboarding_drafts
  for delete
  to authenticated
  using (user_id = auth.uid());

revoke all on table public.businesses from anon;
revoke all on table public.business_members from anon;
revoke all on table public.business_locations from anon;
revoke all on table public.business_onboarding_drafts from anon;

grant select, update on table public.businesses to authenticated;
grant select on table public.business_members to authenticated;
grant select, insert, update on table public.business_locations to authenticated;
grant select, insert, update, delete on table public.business_onboarding_drafts to authenticated;
