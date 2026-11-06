-- Phase 10 v1: notification foundation (tables, enums, RLS)

do $$ begin
  create type public.notification_channel as enum ('email', 'in_app');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_delivery_status as enum (
    'pending', 'processing', 'sent', 'failed', 'dead', 'skipped', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_schedule_status as enum (
    'scheduled', 'materialized', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint notification_events_business_idempotency_unique unique (business_id, idempotency_key)
);

create index if not exists notification_events_business_created_idx
  on public.notification_events (business_id, created_at desc);
create index if not exists notification_events_entity_idx
  on public.notification_events (entity_type, entity_id);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.notification_events (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  channel public.notification_channel not null,
  template_key text not null,
  recipient_user_id uuid references auth.users (id) on delete set null,
  to_email text,
  status public.notification_delivery_status not null default 'pending',
  skip_reason text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  lease_owner text,
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint notification_deliveries_recipient_chk check (
    (channel = 'email' and to_email is not null)
    or (channel = 'in_app' and recipient_user_id is not null)
  )
);

create unique index if not exists notification_deliveries_event_user_uidx
  on public.notification_deliveries (event_id, channel, recipient_user_id)
  where recipient_user_id is not null;

create unique index if not exists notification_deliveries_event_email_uidx
  on public.notification_deliveries (event_id, channel, lower(to_email))
  where to_email is not null;

create index if not exists notification_deliveries_claim_idx
  on public.notification_deliveries (status, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists notification_deliveries_lease_idx
  on public.notification_deliveries (lease_expires_at)
  where status = 'processing';

drop trigger if exists trg_notification_deliveries_updated_at on public.notification_deliveries;
create trigger trg_notification_deliveries_updated_at
before update on public.notification_deliveries
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_deliveries (id) on delete cascade,
  attempt_number integer not null,
  outcome text not null,
  error text,
  provider_status text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists notification_delivery_attempts_delivery_idx
  on public.notification_delivery_attempts (delivery_id, created_at);

create table if not exists public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null unique references public.notification_deliveries (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text not null,
  href text,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists in_app_notifications_user_created_idx
  on public.in_app_notifications (business_id, user_id, created_at desc);

create table if not exists public.notification_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  event_type text not null,
  fire_at timestamptz not null,
  timezone text not null,
  source_starts_at timestamptz not null,
  status public.notification_schedule_status not null default 'scheduled',
  idempotency_key text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint notification_schedules_business_idempotency_unique unique (business_id, idempotency_key)
);

create index if not exists notification_schedules_due_idx
  on public.notification_schedules (status, fire_at)
  where status = 'scheduled';

create index if not exists notification_schedules_booking_idx
  on public.notification_schedules (booking_id, status);

drop trigger if exists trg_notification_schedules_updated_at on public.notification_schedules;
create trigger trg_notification_schedules_updated_at
before update on public.notification_schedules
for each row execute function public.set_updated_at_timestamp();

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null,
  channel public.notification_channel not null,
  enabled boolean not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint notification_preferences_unique unique (business_id, user_id, event_type, channel)
);

drop trigger if exists trg_notification_preferences_updated_at on public.notification_preferences;
create trigger trg_notification_preferences_updated_at
before update on public.notification_preferences
for each row execute function public.set_updated_at_timestamp();

-- RLS
alter table public.notification_events enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_delivery_attempts enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.notification_schedules enable row level security;
alter table public.notification_preferences enable row level security;

drop policy if exists in_app_notifications_select_own on public.in_app_notifications;
create policy in_app_notifications_select_own
  on public.in_app_notifications for select to authenticated
  using (
    user_id = auth.uid()
    and public.is_business_member(business_id)
  );

drop policy if exists in_app_notifications_update_own on public.in_app_notifications;
create policy in_app_notifications_update_own
  on public.in_app_notifications for update to authenticated
  using (user_id = auth.uid() and public.is_business_member(business_id))
  with check (user_id = auth.uid() and public.is_business_member(business_id));

drop policy if exists notification_preferences_select_own on public.notification_preferences;
create policy notification_preferences_select_own
  on public.notification_preferences for select to authenticated
  using (user_id = auth.uid() and public.is_business_member(business_id));

drop policy if exists notification_preferences_upsert_own on public.notification_preferences;
drop policy if exists notification_preferences_insert_own on public.notification_preferences;
create policy notification_preferences_insert_own
  on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid() and public.is_business_member(business_id));

drop policy if exists notification_preferences_update_own on public.notification_preferences;
create policy notification_preferences_update_own
  on public.notification_preferences for update to authenticated
  using (user_id = auth.uid() and public.is_business_member(business_id))
  with check (user_id = auth.uid() and public.is_business_member(business_id));

-- Authenticated: inbox + prefs only. No client access to events/deliveries/schedules/attempts.
revoke all on table public.notification_events from anon, authenticated;
revoke all on table public.notification_deliveries from anon, authenticated;
revoke all on table public.notification_delivery_attempts from anon, authenticated;
revoke all on table public.notification_schedules from anon, authenticated;
revoke all on table public.in_app_notifications from anon, authenticated;
revoke all on table public.notification_preferences from anon, authenticated;

grant select, update on table public.in_app_notifications to authenticated;
grant select, insert, update on table public.notification_preferences to authenticated;
