-- Phase 04: Service catalog (categories, services, add-ons, location settings).
-- Soft-archive only. Money stored as integer minor units + ISO 4217 currency.
-- Owner identity / business_id always verified via membership RLS — never trust client alone.

-- ---------------------------------------------------------------------------
-- Helpers: catalog editors (owner + manager), locked search_path
-- ---------------------------------------------------------------------------
create or replace function public.is_business_catalog_editor(p_business_id uuid)
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
      and bm.role in ('owner', 'manager')
  );
$$;

revoke all on function public.is_business_catalog_editor(uuid) from public;
grant execute on function public.is_business_catalog_editor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- service_categories
-- ---------------------------------------------------------------------------
create table if not exists public.service_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_categories_name_len check (char_length(trim(name)) between 1 and 120),
  constraint service_categories_sort_order_nonneg check (sort_order >= 0)
);

create unique index if not exists service_categories_business_name_active_uidx
  on public.service_categories (business_id, lower(name))
  where archived_at is null;

create index if not exists service_categories_business_sort_idx
  on public.service_categories (business_id, sort_order, created_at);

drop trigger if exists trg_service_categories_updated_at on public.service_categories;
create trigger trg_service_categories_updated_at
before update on public.service_categories
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category_id uuid references public.service_categories (id) on delete set null,
  name text not null,
  description text,
  image_url text,
  price_minor bigint not null,
  currency char(3) not null,
  duration_minutes integer not null,
  processing_minutes integer not null default 0,
  buffer_before_minutes integer not null default 0,
  buffer_after_minutes integer not null default 0,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  is_bookable_online boolean not null default true,
  is_walk_in boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint services_name_len check (char_length(trim(name)) between 1 and 160),
  constraint services_price_nonneg check (price_minor >= 0),
  constraint services_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint services_duration_positive check (duration_minutes > 0 and duration_minutes <= 1440),
  constraint services_processing_nonneg check (processing_minutes >= 0 and processing_minutes <= 1440),
  constraint services_buffer_before_nonneg check (buffer_before_minutes >= 0 and buffer_before_minutes <= 1440),
  constraint services_buffer_after_nonneg check (buffer_after_minutes >= 0 and buffer_after_minutes <= 1440),
  constraint services_sort_order_nonneg check (sort_order >= 0)
);

create index if not exists services_business_sort_idx
  on public.services (business_id, sort_order, created_at);

create index if not exists services_business_category_idx
  on public.services (business_id, category_id)
  where archived_at is null;

create index if not exists services_business_active_idx
  on public.services (business_id)
  where archived_at is null and is_active = true;

drop trigger if exists trg_services_updated_at on public.services;
create trigger trg_services_updated_at
before update on public.services
for each row execute function public.set_updated_at_timestamp();

-- Same-business category FK guard
create or replace function public.enforce_service_category_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_category_business uuid;
begin
  if new.category_id is null then
    return new;
  end if;

  select business_id into v_category_business
  from public.service_categories
  where id = new.category_id;

  if v_category_business is null then
    raise exception 'CATEGORY_NOT_FOUND' using errcode = '23503';
  end if;

  if v_category_business <> new.business_id then
    raise exception 'CROSS_BUSINESS_CATEGORY' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_services_category_same_business on public.services;
create trigger trg_services_category_same_business
before insert or update of category_id, business_id
on public.services
for each row execute function public.enforce_service_category_same_business();

-- ---------------------------------------------------------------------------
-- service_location_settings
-- ---------------------------------------------------------------------------
create table if not exists public.service_location_settings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete cascade,
  is_available boolean not null default true,
  price_minor bigint,
  currency char(3),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_location_settings_unique unique (service_id, location_id),
  constraint service_location_settings_price_nonneg check (price_minor is null or price_minor >= 0),
  constraint service_location_settings_currency_pair check (
    (price_minor is null and currency is null)
    or (price_minor is not null and currency ~ '^[A-Z]{3}$')
  )
);

create index if not exists service_location_settings_business_idx
  on public.service_location_settings (business_id);

create index if not exists service_location_settings_location_idx
  on public.service_location_settings (location_id);

drop trigger if exists trg_service_location_settings_updated_at on public.service_location_settings;
create trigger trg_service_location_settings_updated_at
before update on public.service_location_settings
for each row execute function public.set_updated_at_timestamp();

create or replace function public.enforce_service_location_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_location_business uuid;
begin
  select * into v_service from public.services where id = new.service_id;
  if v_service.id is null then
    raise exception 'SERVICE_NOT_FOUND' using errcode = '23503';
  end if;

  select business_id into v_location_business
  from public.business_locations
  where id = new.location_id;

  if v_location_business is null then
    raise exception 'LOCATION_NOT_FOUND' using errcode = '23503';
  end if;

  if v_service.business_id <> new.business_id
     or v_location_business <> new.business_id then
    raise exception 'CROSS_BUSINESS_LOCATION_SETTING' using errcode = '23514';
  end if;

  if new.price_minor is not null then
    if new.currency is null then
      new.currency := v_service.currency;
    end if;
    if upper(new.currency) <> v_service.currency then
      raise exception 'LOCATION_CURRENCY_MISMATCH' using errcode = '23514';
    end if;
    new.currency := upper(new.currency);
  else
    new.currency := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_service_location_same_business on public.service_location_settings;
create trigger trg_service_location_same_business
before insert or update on public.service_location_settings
for each row execute function public.enforce_service_location_same_business();

-- ---------------------------------------------------------------------------
-- service_addons
-- ---------------------------------------------------------------------------
create table if not exists public.service_addons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  description text,
  price_minor bigint not null,
  currency char(3) not null,
  duration_minutes integer not null default 0,
  is_active boolean not null default true,
  is_optional_default boolean not null default true,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_addons_name_len check (char_length(trim(name)) between 1 and 160),
  constraint service_addons_price_nonneg check (price_minor >= 0),
  constraint service_addons_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint service_addons_duration_nonneg check (duration_minutes >= 0 and duration_minutes <= 1440),
  constraint service_addons_sort_order_nonneg check (sort_order >= 0)
);

create unique index if not exists service_addons_business_name_active_uidx
  on public.service_addons (business_id, lower(name))
  where archived_at is null;

create index if not exists service_addons_business_sort_idx
  on public.service_addons (business_id, sort_order, created_at);

drop trigger if exists trg_service_addons_updated_at on public.service_addons;
create trigger trg_service_addons_updated_at
before update on public.service_addons
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- service_addon_links (preserve on archive of either side — no cascade delete of history intent)
-- ---------------------------------------------------------------------------
create table if not exists public.service_addon_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  addon_id uuid not null references public.service_addons (id) on delete cascade,
  is_optional boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_addon_links_unique unique (service_id, addon_id),
  constraint service_addon_links_sort_order_nonneg check (sort_order >= 0)
);

create index if not exists service_addon_links_business_idx
  on public.service_addon_links (business_id);

create index if not exists service_addon_links_addon_idx
  on public.service_addon_links (addon_id);

drop trigger if exists trg_service_addon_links_updated_at on public.service_addon_links;
create trigger trg_service_addon_links_updated_at
before update on public.service_addon_links
for each row execute function public.set_updated_at_timestamp();

create or replace function public.enforce_service_addon_link_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_service_business uuid;
  v_addon_business uuid;
begin
  select business_id into v_service_business from public.services where id = new.service_id;
  select business_id into v_addon_business from public.service_addons where id = new.addon_id;

  if v_service_business is null or v_addon_business is null then
    raise exception 'SERVICE_OR_ADDON_NOT_FOUND' using errcode = '23503';
  end if;

  if v_service_business <> new.business_id or v_addon_business <> new.business_id then
    raise exception 'CROSS_BUSINESS_ADDON_LINK' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_service_addon_link_same_business on public.service_addon_links;
create trigger trg_service_addon_link_same_business
before insert or update on public.service_addon_links
for each row execute function public.enforce_service_addon_link_same_business();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.service_categories enable row level security;
alter table public.services enable row level security;
alter table public.service_location_settings enable row level security;
alter table public.service_addons enable row level security;
alter table public.service_addon_links enable row level security;

-- categories
drop policy if exists service_categories_select_member on public.service_categories;
create policy service_categories_select_member
  on public.service_categories for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists service_categories_insert_editor on public.service_categories;
create policy service_categories_insert_editor
  on public.service_categories for insert to authenticated
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_categories_update_editor on public.service_categories;
create policy service_categories_update_editor
  on public.service_categories for update to authenticated
  using (public.is_business_catalog_editor(business_id))
  with check (public.is_business_catalog_editor(business_id));

-- No hard delete policy — archive via UPDATE only.

-- services
drop policy if exists services_select_member on public.services;
create policy services_select_member
  on public.services for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists services_insert_editor on public.services;
create policy services_insert_editor
  on public.services for insert to authenticated
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists services_update_editor on public.services;
create policy services_update_editor
  on public.services for update to authenticated
  using (public.is_business_catalog_editor(business_id))
  with check (public.is_business_catalog_editor(business_id));

-- location settings
drop policy if exists service_location_settings_select_member on public.service_location_settings;
create policy service_location_settings_select_member
  on public.service_location_settings for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists service_location_settings_insert_editor on public.service_location_settings;
create policy service_location_settings_insert_editor
  on public.service_location_settings for insert to authenticated
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_location_settings_update_editor on public.service_location_settings;
create policy service_location_settings_update_editor
  on public.service_location_settings for update to authenticated
  using (public.is_business_catalog_editor(business_id))
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_location_settings_delete_editor on public.service_location_settings;
create policy service_location_settings_delete_editor
  on public.service_location_settings for delete to authenticated
  using (public.is_business_catalog_editor(business_id));

-- addons
drop policy if exists service_addons_select_member on public.service_addons;
create policy service_addons_select_member
  on public.service_addons for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists service_addons_insert_editor on public.service_addons;
create policy service_addons_insert_editor
  on public.service_addons for insert to authenticated
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_addons_update_editor on public.service_addons;
create policy service_addons_update_editor
  on public.service_addons for update to authenticated
  using (public.is_business_catalog_editor(business_id))
  with check (public.is_business_catalog_editor(business_id));

-- addon links
drop policy if exists service_addon_links_select_member on public.service_addon_links;
create policy service_addon_links_select_member
  on public.service_addon_links for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists service_addon_links_insert_editor on public.service_addon_links;
create policy service_addon_links_insert_editor
  on public.service_addon_links for insert to authenticated
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_addon_links_update_editor on public.service_addon_links;
create policy service_addon_links_update_editor
  on public.service_addon_links for update to authenticated
  using (public.is_business_catalog_editor(business_id))
  with check (public.is_business_catalog_editor(business_id));

drop policy if exists service_addon_links_delete_editor on public.service_addon_links;
create policy service_addon_links_delete_editor
  on public.service_addon_links for delete to authenticated
  using (public.is_business_catalog_editor(business_id));

revoke all on table public.service_categories from anon;
revoke all on table public.services from anon;
revoke all on table public.service_location_settings from anon;
revoke all on table public.service_addons from anon;
revoke all on table public.service_addon_links from anon;

grant select, insert, update on table public.service_categories to authenticated;
grant select, insert, update on table public.services to authenticated;
grant select, insert, update, delete on table public.service_location_settings to authenticated;
grant select, insert, update on table public.service_addons to authenticated;
grant select, insert, update, delete on table public.service_addon_links to authenticated;
