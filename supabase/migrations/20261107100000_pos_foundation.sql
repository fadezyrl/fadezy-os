-- Phase 09: POS & Payments foundation
-- Append-only financial tables, RLS SELECT for members, writes via SECURITY DEFINER RPCs.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_status') then
    create type public.sale_status as enum (
      'open',
      'partially_paid',
      'paid',
      'partially_refunded',
      'refunded',
      'voided'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'sale_source') then
    create type public.sale_source as enum ('walk_in', 'booking');
  end if;
  if not exists (select 1 from pg_type where typname = 'sale_line_kind') then
    create type public.sale_line_kind as enum ('service', 'addon', 'custom');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_method_kind') then
    create type public.payment_method_kind as enum ('cash', 'card_manual', 'other');
  end if;
  if not exists (select 1 from pg_type where typname = 'register_session_status') then
    create type public.register_session_status as enum ('open', 'closed');
  end if;
  if not exists (select 1 from pg_type where typname = 'cash_movement_kind') then
    create type public.cash_movement_kind as enum (
      'open_float',
      'cash_payment',
      'cash_refund',
      'cash_in',
      'cash_out',
      'close_count'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tax settings (1:1 business)
-- ---------------------------------------------------------------------------
create table if not exists public.business_pos_tax_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  tax_enabled boolean not null default false,
  tax_name text check (tax_name is null or char_length(trim(tax_name)) between 1 and 80),
  rate_bps integer not null default 0 check (rate_bps >= 0 and rate_bps <= 100000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_business_pos_tax_settings_updated_at on public.business_pos_tax_settings;
create trigger trg_business_pos_tax_settings_updated_at
before update on public.business_pos_tax_settings
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- Register sessions
-- ---------------------------------------------------------------------------
create table if not exists public.register_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete restrict,
  status public.register_session_status not null default 'open',
  opening_float_minor bigint not null default 0 check (opening_float_minor >= 0),
  opened_by_user_id uuid references auth.users (id) on delete set null,
  opened_at timestamptz not null default timezone('utc', now()),
  closed_by_user_id uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  expected_minor bigint check (expected_minor is null or expected_minor >= 0),
  counted_minor bigint check (counted_minor is null or counted_minor >= 0),
  discrepancy_minor bigint,
  discrepancy_note text check (discrepancy_note is null or char_length(discrepancy_note) <= 1000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint register_sessions_close_consistency check (
    (status = 'open' and closed_at is null)
    or (status = 'closed' and closed_at is not null and counted_minor is not null and expected_minor is not null)
  )
);

create unique index if not exists register_sessions_one_open_per_location_idx
  on public.register_sessions (location_id)
  where status = 'open';

create index if not exists register_sessions_business_opened_idx
  on public.register_sessions (business_id, opened_at desc);

drop trigger if exists trg_register_sessions_updated_at on public.register_sessions;
create trigger trg_register_sessions_updated_at
before update on public.register_sessions
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.register_cash_movements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.register_sessions (id) on delete restrict,
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind public.cash_movement_kind not null,
  amount_minor bigint not null check (amount_minor >= 0),
  note text check (note is null or char_length(note) <= 500),
  sale_payment_id uuid,
  sale_refund_id uuid,
  actor_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists register_cash_movements_session_idx
  on public.register_cash_movements (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete restrict,
  booking_id uuid references public.bookings (id) on delete restrict,
  customer_id uuid references public.customers (id) on delete set null,
  status public.sale_status not null default 'open',
  source public.sale_source not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
  amount_refunded_minor bigint not null default 0 check (amount_refunded_minor >= 0),
  tax_enabled boolean not null default false,
  tax_name text,
  tax_rate_bps integer not null default 0 check (tax_rate_bps >= 0 and tax_rate_bps <= 100000),
  location_name text not null,
  customer_name text,
  reference_code text not null,
  idempotency_key text not null,
  idempotency_payload_hash text not null,
  notes text check (notes is null or char_length(notes) <= 2000),
  void_reason text,
  voided_at timestamptz,
  voided_by_user_id uuid references auth.users (id) on delete set null,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint sales_total_math check (
    total_minor = subtotal_minor - discount_minor + tax_minor
  ),
  constraint sales_discount_cap check (discount_minor <= subtotal_minor),
  constraint sales_refund_lte_paid check (amount_refunded_minor <= amount_paid_minor),
  constraint sales_reference_unique unique (business_id, reference_code),
  constraint sales_idempotency_unique unique (business_id, idempotency_key)
);

-- Only one non-voided sale per booking
create unique index if not exists sales_one_active_booking_idx
  on public.sales (booking_id)
  where booking_id is not null and status <> 'voided';

create index if not exists sales_business_created_idx
  on public.sales (business_id, created_at desc);
create index if not exists sales_location_created_idx
  on public.sales (location_id, created_at desc);
create index if not exists sales_customer_created_idx
  on public.sales (customer_id, created_at desc)
  where customer_id is not null;

drop trigger if exists trg_sales_updated_at on public.sales;
create trigger trg_sales_updated_at
before update on public.sales
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind public.sale_line_kind not null,
  source_service_id uuid references public.services (id) on delete set null,
  source_addon_id uuid references public.service_addons (id) on delete set null,
  name text not null check (char_length(trim(name)) between 1 and 160),
  quantity integer not null check (quantity >= 1 and quantity <= 100),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  line_subtotal_minor bigint not null check (line_subtotal_minor >= 0),
  allocated_discount_minor bigint not null default 0 check (allocated_discount_minor >= 0),
  taxable_minor bigint not null check (taxable_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  currency char(3) not null,
  sort_order integer not null default 0,
  staff_membership_id uuid references public.business_members (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists sale_lines_sale_idx on public.sale_lines (sale_id, sort_order);

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete restrict,
  business_id uuid not null references public.businesses (id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  method_kind public.payment_method_kind not null,
  method_label text check (method_label is null or char_length(method_label) <= 80),
  register_session_id uuid references public.register_sessions (id) on delete restrict,
  idempotency_key text not null,
  recorded_by_user_id uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default timezone('utc', now()),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default timezone('utc', now()),
  constraint sale_payments_cash_session check (
    (method_kind = 'cash' and register_session_id is not null)
    or (method_kind <> 'cash')
  ),
  constraint sale_payments_idempotency_unique unique (business_id, idempotency_key)
);

create index if not exists sale_payments_sale_idx
  on public.sale_payments (sale_id, recorded_at);

create table if not exists public.sale_refunds (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete restrict,
  payment_id uuid not null references public.sale_payments (id) on delete restrict,
  business_id uuid not null references public.businesses (id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  method_kind public.payment_method_kind not null,
  register_session_id uuid references public.register_sessions (id) on delete restrict,
  idempotency_key text not null,
  recorded_by_user_id uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint sale_refunds_cash_session check (
    (method_kind = 'cash' and register_session_id is not null)
    or (method_kind <> 'cash')
  ),
  constraint sale_refunds_idempotency_unique unique (business_id, idempotency_key)
);

create index if not exists sale_refunds_payment_idx
  on public.sale_refunds (payment_id, recorded_at);
create index if not exists sale_refunds_sale_idx
  on public.sale_refunds (sale_id, recorded_at);

alter table public.register_cash_movements
  drop constraint if exists register_cash_movements_sale_payment_id_fkey;
alter table public.register_cash_movements
  add constraint register_cash_movements_sale_payment_id_fkey
  foreign key (sale_payment_id) references public.sale_payments (id) on delete set null;

alter table public.register_cash_movements
  drop constraint if exists register_cash_movements_sale_refund_id_fkey;
alter table public.register_cash_movements
  add constraint register_cash_movements_sale_refund_id_fkey
  foreign key (sale_refund_id) references public.sale_refunds (id) on delete set null;

create table if not exists public.sale_events (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_type text not null check (char_length(trim(event_type)) between 1 and 64),
  actor_user_id uuid references auth.users (id) on delete set null,
  payload jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists sale_events_sale_idx
  on public.sale_events (sale_id, created_at);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_pos_location_member(
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

revoke all on function public.is_pos_location_member(uuid, uuid) from public;
grant execute on function public.is_pos_location_member(uuid, uuid) to authenticated;

create or replace function public.generate_sale_reference(p_business_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_attempt integer := 0;
begin
  loop
    v_attempt := v_attempt + 1;
    v_code := 'S' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (
      select 1 from public.sales where business_id = p_business_id and reference_code = v_code
    );
    if v_attempt > 20 then
      raise exception 'SALE_REFERENCE_FAILED' using errcode = 'P0001';
    end if;
  end loop;
  return v_code;
end;
$$;

revoke all on function public.generate_sale_reference(uuid) from public;

create or replace function public.register_session_expected_minor(p_session_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(
    case m.kind
      when 'open_float' then m.amount_minor
      when 'cash_payment' then m.amount_minor
      when 'cash_refund' then -m.amount_minor
      when 'cash_in' then m.amount_minor
      when 'cash_out' then -m.amount_minor
      when 'close_count' then 0
      else 0
    end
  ), 0)::bigint
  from public.register_cash_movements m
  where m.session_id = p_session_id;
$$;

revoke all on function public.register_session_expected_minor(uuid) from public;
grant execute on function public.register_session_expected_minor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.business_pos_tax_settings enable row level security;
alter table public.register_sessions enable row level security;
alter table public.register_cash_movements enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.sale_payments enable row level security;
alter table public.sale_refunds enable row level security;
alter table public.sale_events enable row level security;

drop policy if exists pos_tax_select_member on public.business_pos_tax_settings;
create policy pos_tax_select_member
  on public.business_pos_tax_settings for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists pos_tax_update_editor on public.business_pos_tax_settings;
create policy pos_tax_update_editor
  on public.business_pos_tax_settings for update to authenticated
  using (public.is_business_schedule_editor(business_id))
  with check (public.is_business_schedule_editor(business_id));

drop policy if exists pos_tax_insert_editor on public.business_pos_tax_settings;
create policy pos_tax_insert_editor
  on public.business_pos_tax_settings for insert to authenticated
  with check (public.is_business_schedule_editor(business_id));

drop policy if exists sales_select_member on public.sales;
create policy sales_select_member
  on public.sales for select to authenticated
  using (public.is_pos_location_member(business_id, location_id));

drop policy if exists sale_lines_select_member on public.sale_lines;
create policy sale_lines_select_member
  on public.sale_lines for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_id and public.is_pos_location_member(s.business_id, s.location_id)
    )
  );

drop policy if exists sale_payments_select_member on public.sale_payments;
create policy sale_payments_select_member
  on public.sale_payments for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_id and public.is_pos_location_member(s.business_id, s.location_id)
    )
  );

drop policy if exists sale_refunds_select_member on public.sale_refunds;
create policy sale_refunds_select_member
  on public.sale_refunds for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_id and public.is_pos_location_member(s.business_id, s.location_id)
    )
  );

drop policy if exists sale_events_select_member on public.sale_events;
create policy sale_events_select_member
  on public.sale_events for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_id and public.is_pos_location_member(s.business_id, s.location_id)
    )
  );

drop policy if exists register_sessions_select_member on public.register_sessions;
create policy register_sessions_select_member
  on public.register_sessions for select to authenticated
  using (public.is_pos_location_member(business_id, location_id));

drop policy if exists register_movements_select_member on public.register_cash_movements;
create policy register_movements_select_member
  on public.register_cash_movements for select to authenticated
  using (
    exists (
      select 1 from public.register_sessions rs
      where rs.id = session_id and public.is_pos_location_member(rs.business_id, rs.location_id)
    )
  );

-- Grants: SELECT only for ledger tables; tax settings allow upsert for editors under RLS
revoke all on table public.business_pos_tax_settings from anon;
revoke all on table public.business_pos_tax_settings from authenticated;
grant select, insert, update on table public.business_pos_tax_settings to authenticated;

revoke all on table public.register_sessions from anon;
revoke all on table public.register_sessions from authenticated;
grant select on table public.register_sessions to authenticated;

revoke all on table public.register_cash_movements from anon;
revoke all on table public.register_cash_movements from authenticated;
grant select on table public.register_cash_movements to authenticated;

revoke all on table public.sales from anon;
revoke all on table public.sales from authenticated;
grant select on table public.sales to authenticated;

revoke all on table public.sale_lines from anon;
revoke all on table public.sale_lines from authenticated;
grant select on table public.sale_lines to authenticated;

revoke all on table public.sale_payments from anon;
revoke all on table public.sale_payments from authenticated;
grant select on table public.sale_payments to authenticated;

revoke all on table public.sale_refunds from anon;
revoke all on table public.sale_refunds from authenticated;
grant select on table public.sale_refunds to authenticated;

revoke all on table public.sale_events from anon;
revoke all on table public.sale_events from authenticated;
grant select on table public.sale_events to authenticated;
