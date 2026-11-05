-- Phase 02: minimal identity profile linked to Supabase Auth.
-- auth.users remains the source of truth for credentials and verification.

create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint user_profiles_full_name_length check (
    full_name is null or char_length(full_name) <= 120
  ),
  constraint user_profiles_avatar_url_length check (
    avatar_url is null or char_length(avatar_url) <= 2048
  )
);

create index if not exists user_profiles_created_at_idx
  on public.user_profiles (created_at desc);

comment on table public.user_profiles is
  'Public profile extension for auth.users. No business membership data.';

-- Keep updated_at in UTC and block identity spoofing on update.
create or replace function public.set_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id then
    raise exception 'user_profiles.id is immutable';
  end if;
  new.updated_at = timezone('utc', now());
  new.created_at = old.created_at;
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_user_profiles_updated_at();

-- Create a profile row when a new auth user registers.
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, full_name)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row
execute function public.handle_new_user_profile();

alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
  on public.user_profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "user_profiles_update_own" on public.user_profiles;
create policy "user_profiles_update_own"
  on public.user_profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Ordinary users cannot insert/delete arbitrary profiles.
-- Inserts are performed by the auth trigger (security definer).
drop policy if exists "user_profiles_insert_own" on public.user_profiles;
drop policy if exists "user_profiles_delete_own" on public.user_profiles;

revoke all on table public.user_profiles from anon;
grant select, update on table public.user_profiles to authenticated;
