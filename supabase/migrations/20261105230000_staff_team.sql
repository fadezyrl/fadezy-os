-- Phase 05: Staff & team management
-- Membership remains the tenant link. Invitations hold pre-accept state.
-- Accept RPC uses auth.uid() only — never creates Auth users.

-- ---------------------------------------------------------------------------
-- Extend business_members lifecycle columns
-- ---------------------------------------------------------------------------
alter table public.business_members
  add column if not exists invited_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists deactivated_at timestamptz,
  add column if not exists invited_by uuid references auth.users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_business_team_manager(p_business_id uuid)
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

create or replace function public.count_active_owners(p_business_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.business_members bm
  where bm.business_id = p_business_id
    and bm.role = 'owner'
    and bm.membership_status = 'active'
    and bm.deactivated_at is null;
$$;

-- Keep member helper requiring active + not deactivated
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
      and bm.deactivated_at is null
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
      and bm.deactivated_at is null
  );
$$;

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
      and bm.deactivated_at is null
      and bm.role in ('owner', 'manager')
  );
$$;

revoke all on function public.is_business_team_manager(uuid) from public;
revoke all on function public.count_active_owners(uuid) from public;
grant execute on function public.is_business_team_manager(uuid) to authenticated;
grant execute on function public.count_active_owners(uuid) to authenticated;
grant execute on function public.is_business_member(uuid) to authenticated;
grant execute on function public.is_business_owner(uuid) to authenticated;
grant execute on function public.is_business_catalog_editor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- invitation status enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'invitation_status') then
    create type public.invitation_status as enum ('pending', 'accepted', 'cancelled', 'expired');
  end if;
  if not exists (select 1 from pg_type where typname = 'employment_type') then
    create type public.employment_type as enum ('full_time', 'part_time', 'contractor', 'other');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- business_invitations
-- ---------------------------------------------------------------------------
create table if not exists public.business_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email text not null,
  role public.business_role not null,
  invited_by uuid not null references auth.users (id) on delete restrict,
  display_name text,
  token_hash text not null,
  status public.invitation_status not null default 'pending',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  location_ids uuid[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint business_invitations_email_len check (char_length(trim(email)) between 3 and 320),
  constraint business_invitations_role_invitable check (role in ('manager', 'staff')),
  constraint business_invitations_token_hash_unique unique (token_hash)
);

create unique index if not exists business_invitations_pending_email_uidx
  on public.business_invitations (business_id, lower(email))
  where status = 'pending';

create index if not exists business_invitations_business_status_idx
  on public.business_invitations (business_id, status, created_at desc);

drop trigger if exists trg_business_invitations_updated_at on public.business_invitations;
create trigger trg_business_invitations_updated_at
before update on public.business_invitations
for each row execute function public.set_updated_at_timestamp();

-- ---------------------------------------------------------------------------
-- staff_profiles
-- ---------------------------------------------------------------------------
create table if not exists public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  email text,
  image_url text,
  phone text,
  job_title text,
  employment_type public.employment_type,
  bio text,
  start_date date,
  internal_notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint staff_profiles_membership_unique unique (membership_id),
  constraint staff_profiles_business_user_unique unique (business_id, user_id),
  constraint staff_profiles_display_name_len check (char_length(trim(display_name)) between 1 and 120)
);

create index if not exists staff_profiles_business_id_idx on public.staff_profiles (business_id);

drop trigger if exists trg_staff_profiles_updated_at on public.staff_profiles;
create trigger trg_staff_profiles_updated_at
before update on public.staff_profiles
for each row execute function public.set_updated_at_timestamp();

create or replace function public.enforce_staff_profile_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_member public.business_members%rowtype;
begin
  select * into v_member from public.business_members where id = new.membership_id;
  if v_member.id is null then
    raise exception 'MEMBERSHIP_NOT_FOUND' using errcode = '23503';
  end if;
  if v_member.business_id <> new.business_id or v_member.user_id <> new.user_id then
    raise exception 'CROSS_BUSINESS_STAFF_PROFILE' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_profiles_same_business on public.staff_profiles;
create trigger trg_staff_profiles_same_business
before insert or update on public.staff_profiles
for each row execute function public.enforce_staff_profile_same_business();

-- ---------------------------------------------------------------------------
-- staff_location_assignments
-- ---------------------------------------------------------------------------
create table if not exists public.staff_location_assignments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  location_id uuid not null references public.business_locations (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint staff_location_assignments_unique unique (membership_id, location_id)
);

create index if not exists staff_location_assignments_business_idx
  on public.staff_location_assignments (business_id);

create or replace function public.enforce_staff_location_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_member_business uuid;
  v_location_business uuid;
begin
  select business_id into v_member_business from public.business_members where id = new.membership_id;
  select business_id into v_location_business from public.business_locations where id = new.location_id;
  if v_member_business is null or v_location_business is null then
    raise exception 'MEMBER_OR_LOCATION_NOT_FOUND' using errcode = '23503';
  end if;
  if v_member_business <> new.business_id or v_location_business <> new.business_id then
    raise exception 'CROSS_BUSINESS_STAFF_LOCATION' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_location_same_business on public.staff_location_assignments;
create trigger trg_staff_location_same_business
before insert or update on public.staff_location_assignments
for each row execute function public.enforce_staff_location_same_business();

-- ---------------------------------------------------------------------------
-- staff_service_assignments (eligibility only)
-- ---------------------------------------------------------------------------
create table if not exists public.staff_service_assignments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  membership_id uuid not null references public.business_members (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint staff_service_assignments_unique unique (membership_id, service_id)
);

create index if not exists staff_service_assignments_business_idx
  on public.staff_service_assignments (business_id);

create or replace function public.enforce_staff_service_same_business()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_member_business uuid;
  v_service_business uuid;
begin
  select business_id into v_member_business from public.business_members where id = new.membership_id;
  select business_id into v_service_business from public.services where id = new.service_id;
  if v_member_business is null or v_service_business is null then
    raise exception 'MEMBER_OR_SERVICE_NOT_FOUND' using errcode = '23503';
  end if;
  if v_member_business <> new.business_id or v_service_business <> new.business_id then
    raise exception 'CROSS_BUSINESS_STAFF_SERVICE' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_service_same_business on public.staff_service_assignments;
create trigger trg_staff_service_same_business
before insert or update on public.staff_service_assignments
for each row execute function public.enforce_staff_service_same_business();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create invitation (caller must be owner, or manager inviting staff only)
create or replace function public.create_business_invitation(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_business_id uuid;
  v_role public.business_role;
  v_caller_role public.business_role;
  v_email text;
  v_token_hash text;
  v_invite public.business_invitations%rowtype;
  v_location_ids uuid[];
  v_loc uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  v_business_id := (payload->>'business_id')::uuid;
  v_role := (payload->>'role')::public.business_role;
  v_email := lower(trim(payload->>'email'));
  v_token_hash := trim(payload->>'token_hash');
  v_location_ids := coalesce(
    array(select jsonb_array_elements_text(payload->'location_ids'))::uuid[],
    '{}'::uuid[]
  );

  if v_business_id is null or v_email is null or v_token_hash is null or v_token_hash = '' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023';
  end if;

  if v_role not in ('manager', 'staff') then
    raise exception 'INVALID_INVITE_ROLE' using errcode = '22023';
  end if;

  select role into v_caller_role
  from public.business_members
  where business_id = v_business_id
    and user_id = v_user_id
    and membership_status = 'active'
    and deactivated_at is null;

  if v_caller_role is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_caller_role = 'staff' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_caller_role = 'manager' and v_role <> 'staff' then
    raise exception 'MANAGER_INVITE_STAFF_ONLY' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.business_members bm
    join auth.users u on u.id = bm.user_id
    where bm.business_id = v_business_id
      and lower(u.email) = v_email
      and bm.deactivated_at is null
      and bm.membership_status in ('active', 'invited', 'suspended')
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;

  foreach v_loc in array v_location_ids loop
    if not exists (
      select 1 from public.business_locations
      where id = v_loc and business_id = v_business_id
    ) then
      raise exception 'INVALID_LOCATION' using errcode = '22023';
    end if;
  end loop;

  -- Cancel any prior pending invite for same email
  update public.business_invitations
  set status = 'cancelled',
      cancelled_at = timezone('utc', now())
  where business_id = v_business_id
    and lower(email) = v_email
    and status = 'pending';

  insert into public.business_invitations (
    business_id,
    email,
    role,
    invited_by,
    display_name,
    token_hash,
    status,
    expires_at,
    location_ids
  )
  values (
    v_business_id,
    v_email,
    v_role,
    v_user_id,
    nullif(trim(payload->>'display_name'), ''),
    v_token_hash,
    'pending',
    timezone('utc', now()) + interval '7 days',
    v_location_ids
  )
  returning * into v_invite;

  return to_jsonb(v_invite);
end;
$$;

revoke all on function public.create_business_invitation(jsonb) from public;
grant execute on function public.create_business_invitation(jsonb) to authenticated;

-- Accept invitation: authenticated user with verified matching email
create or replace function public.accept_business_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite public.business_invitations%rowtype;
  v_user auth.users%rowtype;
  v_member public.business_members%rowtype;
  v_profile public.staff_profiles%rowtype;
  v_loc uuid;
  v_display text;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_token_hash is null or length(trim(p_token_hash)) < 16 then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;

  select * into v_invite
  from public.business_invitations
  where token_hash = trim(p_token_hash)
  for update;

  if v_invite.id is null then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_invite.status = 'accepted' then
    -- Idempotent: return existing membership if this user already accepted
    select * into v_member
    from public.business_members
    where business_id = v_invite.business_id and user_id = v_user_id;
    if v_member.id is not null then
      select * into v_profile from public.staff_profiles where membership_id = v_member.id;
      return jsonb_build_object(
        'invitation', to_jsonb(v_invite),
        'membership', to_jsonb(v_member),
        'staff_profile', to_jsonb(v_profile),
        'idempotent_replay', true
      );
    end if;
    raise exception 'INVITE_ALREADY_USED' using errcode = '22023';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING' using errcode = '22023';
  end if;

  if v_invite.expires_at <= timezone('utc', now()) then
    update public.business_invitations
    set status = 'expired'
    where id = v_invite.id;
    raise exception 'INVITE_EXPIRED' using errcode = '22023';
  end if;

  select * into v_user from auth.users where id = v_user_id;
  if v_user.id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if v_user.email_confirmed_at is null then
    raise exception 'EMAIL_NOT_VERIFIED' using errcode = '42501';
  end if;

  if lower(v_user.email) <> lower(v_invite.email) then
    raise exception 'EMAIL_MISMATCH' using errcode = '42501';
  end if;

  select * into v_member
  from public.business_members
  where business_id = v_invite.business_id and user_id = v_user_id;

  if v_member.id is not null then
    if v_member.deactivated_at is not null then
      update public.business_members
      set membership_status = 'active',
          deactivated_at = null,
          suspended_at = null,
          role = v_invite.role,
          accepted_at = timezone('utc', now())
      where id = v_member.id
      returning * into v_member;
    elsif v_member.membership_status = 'suspended' then
      update public.business_members
      set membership_status = 'active',
          suspended_at = null,
          role = v_invite.role,
          accepted_at = timezone('utc', now())
      where id = v_member.id
      returning * into v_member;
    end if;
  else
    insert into public.business_members (
      business_id,
      user_id,
      role,
      membership_status,
      invited_at,
      accepted_at,
      invited_by
    )
    values (
      v_invite.business_id,
      v_user_id,
      v_invite.role,
      'active',
      v_invite.created_at,
      timezone('utc', now()),
      v_invite.invited_by
    )
    returning * into v_member;
  end if;

  v_display := coalesce(
    nullif(trim(v_invite.display_name), ''),
    nullif(trim(coalesce(v_user.raw_user_meta_data->>'full_name', '')), ''),
    split_part(v_user.email, '@', 1)
  );

  select * into v_profile from public.staff_profiles where membership_id = v_member.id;
  if v_profile.id is null then
    insert into public.staff_profiles (
      business_id,
      membership_id,
      user_id,
      display_name,
      email
    )
    values (
      v_invite.business_id,
      v_member.id,
      v_user_id,
      v_display,
      lower(v_user.email)
    )
    returning * into v_profile;
  else
    update public.staff_profiles
    set email = coalesce(email, lower(v_user.email))
    where id = v_profile.id
    returning * into v_profile;
  end if;

  delete from public.staff_location_assignments where membership_id = v_member.id;
  foreach v_loc in array coalesce(v_invite.location_ids, '{}'::uuid[]) loop
    insert into public.staff_location_assignments (business_id, membership_id, location_id)
    values (v_invite.business_id, v_member.id, v_loc)
    on conflict do nothing;
  end loop;

  update public.business_invitations
  set status = 'accepted',
      accepted_at = timezone('utc', now())
  where id = v_invite.id
  returning * into v_invite;

  return jsonb_build_object(
    'invitation', to_jsonb(v_invite),
    'membership', to_jsonb(v_member),
    'staff_profile', to_jsonb(v_profile),
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.accept_business_invitation(text) from public;
grant execute on function public.accept_business_invitation(text) to authenticated;

-- Cancel invitation
create or replace function public.cancel_business_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite public.business_invitations%rowtype;
  v_caller_role public.business_role;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_invite from public.business_invitations where id = p_invitation_id;
  if v_invite.id is null then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select role into v_caller_role
  from public.business_members
  where business_id = v_invite.business_id
    and user_id = v_user_id
    and membership_status = 'active'
    and deactivated_at is null;

  if v_caller_role is null or v_caller_role = 'staff' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING' using errcode = '22023';
  end if;

  update public.business_invitations
  set status = 'cancelled',
      cancelled_at = timezone('utc', now())
  where id = p_invitation_id
  returning * into v_invite;

  return to_jsonb(v_invite);
end;
$$;

revoke all on function public.cancel_business_invitation(uuid) from public;
grant execute on function public.cancel_business_invitation(uuid) to authenticated;

-- Update member role (owner only; never last owner demotion)
create or replace function public.update_business_member_role(
  p_membership_id uuid,
  p_role public.business_role
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_member public.business_members%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_role not in ('manager', 'staff') then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  select * into v_member from public.business_members where id = p_membership_id;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.is_business_owner(v_member.business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_member.role = 'owner' then
    if public.count_active_owners(v_member.business_id) <= 1 then
      raise exception 'LAST_OWNER_PROTECTED' using errcode = '42501';
    end if;
  end if;

  if v_member.user_id = v_user_id and v_member.role = 'owner' then
    if public.count_active_owners(v_member.business_id) <= 1 then
      raise exception 'LAST_OWNER_PROTECTED' using errcode = '42501';
    end if;
  end if;

  update public.business_members
  set role = p_role
  where id = p_membership_id
  returning * into v_member;

  return to_jsonb(v_member);
end;
$$;

revoke all on function public.update_business_member_role(uuid, public.business_role) from public;
grant execute on function public.update_business_member_role(uuid, public.business_role) to authenticated;

-- Update member status: suspend | reactivate | deactivate
create or replace function public.update_business_member_status(
  p_membership_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_member public.business_members%rowtype;
  v_caller_role public.business_role;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member from public.business_members where id = p_membership_id;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select role into v_caller_role
  from public.business_members
  where business_id = v_member.business_id
    and user_id = v_user_id
    and membership_status = 'active'
    and deactivated_at is null;

  if v_caller_role is null or v_caller_role = 'staff' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_caller_role = 'manager' and v_member.role in ('owner', 'manager') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_member.role = 'owner' and public.count_active_owners(v_member.business_id) <= 1 then
    raise exception 'LAST_OWNER_PROTECTED' using errcode = '42501';
  end if;

  if v_member.user_id = v_user_id then
    raise exception 'CANNOT_MODIFY_SELF_STATUS' using errcode = '42501';
  end if;

  if p_action = 'suspend' then
    update public.business_members
    set membership_status = 'suspended',
        suspended_at = timezone('utc', now())
    where id = p_membership_id
    returning * into v_member;
  elsif p_action = 'reactivate' then
    update public.business_members
    set membership_status = 'active',
        suspended_at = null,
        deactivated_at = null
    where id = p_membership_id
    returning * into v_member;
  elsif p_action = 'deactivate' then
    update public.business_members
    set membership_status = 'suspended',
        deactivated_at = timezone('utc', now()),
        suspended_at = coalesce(suspended_at, timezone('utc', now()))
    where id = p_membership_id
    returning * into v_member;
  else
    raise exception 'INVALID_ACTION' using errcode = '22023';
  end if;

  return to_jsonb(v_member);
end;
$$;

revoke all on function public.update_business_member_status(uuid, text) from public;
grant execute on function public.update_business_member_status(uuid, text) to authenticated;

-- Set location assignments
create or replace function public.set_staff_locations(
  p_membership_id uuid,
  p_location_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.business_members%rowtype;
  v_loc uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member from public.business_members where id = p_membership_id;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.is_business_team_manager(v_member.business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  foreach v_loc in array coalesce(p_location_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.business_locations
      where id = v_loc and business_id = v_member.business_id
    ) then
      raise exception 'INVALID_LOCATION' using errcode = '22023';
    end if;
  end loop;

  delete from public.staff_location_assignments where membership_id = p_membership_id;

  foreach v_loc in array coalesce(p_location_ids, '{}'::uuid[]) loop
    insert into public.staff_location_assignments (business_id, membership_id, location_id)
    values (v_member.business_id, p_membership_id, v_loc);
  end loop;

  return jsonb_build_object(
    'membership_id', p_membership_id,
    'location_ids', coalesce(p_location_ids, '{}'::uuid[])
  );
end;
$$;

revoke all on function public.set_staff_locations(uuid, uuid[]) from public;
grant execute on function public.set_staff_locations(uuid, uuid[]) to authenticated;

-- Set service eligibility
create or replace function public.set_staff_services(
  p_membership_id uuid,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.business_members%rowtype;
  v_svc uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member from public.business_members where id = p_membership_id;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.is_business_team_manager(v_member.business_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  foreach v_svc in array coalesce(p_service_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.services
      where id = v_svc and business_id = v_member.business_id and archived_at is null
    ) then
      raise exception 'INVALID_SERVICE' using errcode = '22023';
    end if;
  end loop;

  delete from public.staff_service_assignments where membership_id = p_membership_id;

  foreach v_svc in array coalesce(p_service_ids, '{}'::uuid[]) loop
    insert into public.staff_service_assignments (business_id, membership_id, service_id)
    values (v_member.business_id, p_membership_id, v_svc);
  end loop;

  return jsonb_build_object(
    'membership_id', p_membership_id,
    'service_ids', coalesce(p_service_ids, '{}'::uuid[])
  );
end;
$$;

revoke all on function public.set_staff_services(uuid, uuid[]) from public;
grant execute on function public.set_staff_services(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.business_invitations enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.staff_location_assignments enable row level security;
alter table public.staff_service_assignments enable row level security;

-- Invitations: team managers can select; mutations via RPC only
drop policy if exists business_invitations_select_manager on public.business_invitations;
create policy business_invitations_select_manager
  on public.business_invitations for select to authenticated
  using (public.is_business_team_manager(business_id));

-- Staff profiles: members can select (notes filtered in API for staff)
drop policy if exists staff_profiles_select_member on public.staff_profiles;
create policy staff_profiles_select_member
  on public.staff_profiles for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists staff_profiles_insert_manager_or_self on public.staff_profiles;
create policy staff_profiles_insert_manager_or_self
  on public.staff_profiles for insert to authenticated
  with check (
    public.is_business_team_manager(business_id)
    or user_id = auth.uid()
  );

drop policy if exists staff_profiles_update_manager_or_self on public.staff_profiles;
create policy staff_profiles_update_manager_or_self
  on public.staff_profiles for update to authenticated
  using (
    public.is_business_team_manager(business_id)
    or user_id = auth.uid()
  )
  with check (
    public.is_business_team_manager(business_id)
    or user_id = auth.uid()
  );

-- Assignments
drop policy if exists staff_location_assignments_select_member on public.staff_location_assignments;
create policy staff_location_assignments_select_member
  on public.staff_location_assignments for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists staff_service_assignments_select_member on public.staff_service_assignments;
create policy staff_service_assignments_select_member
  on public.staff_service_assignments for select to authenticated
  using (public.is_business_member(business_id));

-- Allow active members to see all memberships in their business (directory)
-- existing select policy already covers this via is_business_member

revoke all on table public.business_invitations from anon;
revoke all on table public.staff_profiles from anon;
revoke all on table public.staff_location_assignments from anon;
revoke all on table public.staff_service_assignments from anon;

grant select on table public.business_invitations to authenticated;
grant select, insert, update on table public.staff_profiles to authenticated;
grant select on table public.staff_location_assignments to authenticated;
grant select on table public.staff_service_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill staff profiles for existing members (owners from Phase 03)
-- ---------------------------------------------------------------------------
insert into public.staff_profiles (business_id, membership_id, user_id, display_name, email)
select
  bm.business_id,
  bm.id,
  bm.user_id,
  coalesce(
    nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
    split_part(au.email, '@', 1),
    'Owner'
  ),
  lower(au.email)
from public.business_members bm
join auth.users au on au.id = bm.user_id
where not exists (
  select 1 from public.staff_profiles sp where sp.membership_id = bm.id
);

-- Ensure new businesses create an owner staff_profile (extends Phase 03 RPC)
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
  v_profile public.staff_profiles%rowtype;
  v_client_request_id uuid;
  v_existing_id uuid;
  v_location_json jsonb;
  v_user auth.users%rowtype;
  v_display text;
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
      select * into v_profile from public.staff_profiles where membership_id = v_member.id;

      return jsonb_build_object(
        'business', to_jsonb(v_business),
        'membership', to_jsonb(v_member),
        'primary_location', to_jsonb(v_location),
        'staff_profile', to_jsonb(v_profile),
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
    membership_status,
    accepted_at
  )
  values (
    v_business.id,
    v_user_id,
    'owner',
    'active',
    timezone('utc', now())
  )
  returning * into v_member;

  select * into v_user from auth.users where id = v_user_id;
  v_display := coalesce(
    nullif(trim(coalesce(v_user.raw_user_meta_data->>'full_name', '')), ''),
    split_part(coalesce(v_user.email, 'owner'), '@', 1),
    'Owner'
  );

  insert into public.staff_profiles (
    business_id,
    membership_id,
    user_id,
    display_name,
    email,
    job_title
  )
  values (
    v_business.id,
    v_member.id,
    v_user_id,
    v_display,
    lower(v_user.email),
    'Owner'
  )
  returning * into v_profile;

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
    'staff_profile', to_jsonb(v_profile),
    'idempotent_replay', false
  );
exception
  when unique_violation then
    raise exception 'SLUG_OR_REQUEST_CONFLICT' using errcode = '23505';
end;
$$;

revoke all on function public.create_business_with_owner(jsonb) from public;
grant execute on function public.create_business_with_owner(jsonb) to authenticated;
