-- Phase 07 guest RPC isolation: dedicated login role (password set out-of-band).
-- Keeps anon/authenticated EXECUTE until Express guest-pool path is verified
-- (revocation in 20261105290000).
-- Note: avoid ALTER ROLE attribute resets — Supabase postgres is CREATEROLE but not SUPERUSER.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fadezy_guest_rpc') then
    create role fadezy_guest_rpc
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls
      noreplication
      noinherit
      nologin;
  end if;
end
$$;

grant connect on database postgres to fadezy_guest_rpc;
grant usage on schema public to fadezy_guest_rpc;

-- No table grants. SECURITY DEFINER guest RPCs run as owner for data access.
revoke all on table public.bookings from fadezy_guest_rpc;
revoke all on table public.customers from fadezy_guest_rpc;
revoke all on table public.booking_services from fadezy_guest_rpc;
revoke all on table public.booking_addons from fadezy_guest_rpc;
revoke all on table public.booking_status_events from fadezy_guest_rpc;

grant execute on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) to fadezy_guest_rpc;

grant execute on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) to fadezy_guest_rpc;

-- Explicitly withhold workspace / internal RPCs
revoke all on function public.assert_can_manage_booking_location(uuid, uuid)
  from fadezy_guest_rpc;
revoke all on function public.create_workspace_booking(
  uuid, uuid, uuid, uuid, uuid[], timestamptz, uuid, text, text, text, text, text, text, text
) from fadezy_guest_rpc;
revoke all on function public.reschedule_booking_times(uuid, timestamptz)
  from fadezy_guest_rpc;
revoke all on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz)
  from fadezy_guest_rpc;
revoke all on function public.transition_booking_status(
  uuid, public.booking_status, text, timestamptz, timestamptz
) from fadezy_guest_rpc;

-- Password / LOGIN: provisioned by scripts/provision-guest-rpc-role.mjs (not stored in SQL).
