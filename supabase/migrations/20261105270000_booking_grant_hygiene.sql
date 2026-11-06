-- Phase 07 final grant hygiene.
-- Narrow EXECUTE on occupancy/status RPCs; strip excess authenticated table DML/TRUNCATE.
-- Does not alter SECURITY DEFINER bodies or guest booking RPCs (rate-limit architecture separate).

-- ---------------------------------------------------------------------------
-- list_staff_busy_ranges: workspace slot engine only (user-scoped client).
-- Guest availability uses guest_get_booking_slot_context — anon EXECUTE not required.
-- ---------------------------------------------------------------------------
revoke all on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz) from anon;
grant execute on function public.list_staff_busy_ranges(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- transition_booking_status: authenticated workspace lifecycle only.
-- Body already requires auth.uid(); remove residual anon EXECUTE from auto-grants.
-- ---------------------------------------------------------------------------
revoke all on function public.transition_booking_status(
  uuid, public.booking_status, text, timestamptz, timestamptz
) from public;
revoke all on function public.transition_booking_status(
  uuid, public.booking_status, text, timestamptz, timestamptz
) from anon;
grant execute on function public.transition_booking_status(
  uuid, public.booking_status, text, timestamptz, timestamptz
) to authenticated;

-- ---------------------------------------------------------------------------
-- Booking tables: RPCs are authoritative for writes.
-- Preserve SELECT for workspace RLS reads; remove INSERT/UPDATE/DELETE/TRUNCATE/etc.
-- ---------------------------------------------------------------------------
revoke all on table public.bookings from anon;
revoke all on table public.bookings from authenticated;
grant select on table public.bookings to authenticated;

revoke all on table public.booking_services from anon;
revoke all on table public.booking_services from authenticated;
grant select on table public.booking_services to authenticated;

revoke all on table public.booking_addons from anon;
revoke all on table public.booking_addons from authenticated;
grant select on table public.booking_addons to authenticated;

revoke all on table public.booking_status_events from anon;
revoke all on table public.booking_status_events from authenticated;
grant select on table public.booking_status_events to authenticated;

-- ---------------------------------------------------------------------------
-- Customers: intentional CRM SELECT/INSERT/UPDATE under RLS.
-- Remove DELETE/TRUNCATE/REFERENCES/TRIGGER excess.
-- ---------------------------------------------------------------------------
revoke all on table public.customers from anon;
revoke all on table public.customers from authenticated;
grant select, insert, update on table public.customers to authenticated;
