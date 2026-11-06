-- Phase 07 guest RPC isolation cutover (step 2).
-- Apply ONLY after Express GUEST_RPC_DATABASE_URL path is verified.
-- Revokes PostgREST-reachable EXECUTE on guest RPCs from anon/authenticated.
-- Optionally drops residual service_role EXECUTE (app does not use it for guest).

revoke all on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) from public;
revoke all on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) from anon;
revoke all on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) from authenticated;
revoke all on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) from service_role;
grant execute on function public.guest_get_booking_slot_context(
  text, uuid, uuid, uuid, uuid[], date
) to fadezy_guest_rpc;

revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from public;
revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from anon;
revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from authenticated;
revoke all on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) from service_role;
grant execute on function public.create_guest_booking(
  text, uuid, uuid, uuid, uuid[], timestamptz, text, text, text, text, text, text
) to fadezy_guest_rpc;
