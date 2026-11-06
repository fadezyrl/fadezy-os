-- Phase 09 remediation: SECURITY DEFINER helper grant hygiene
--
-- Dependency analysis:
--   is_pos_location_member          → used by RLS policies; authenticated EXECUTE required
--   register_session_expected_minor → called only by close_register_session (DEFINER as owner)
--   generate_sale_reference         → called only by create_walk_in_sale / checkout_booking_to_sale
--   assert_pos_manager              → called only by mutation DEFINER RPCs
--   assert_can_manage_pos_location  → called only by mutation DEFINER RPCs
--   pos_calculate_sale_from_lines   → called only by create_walk_in_sale / update_open_sale
--   pos_insert_sale_lines           → called only by create / checkout / update_open_sale
--   pos_sale_to_jsonb               → called only by mutation DEFINER RPCs
--   pos_calculate_sale_from_booking_snapshots → checkout_booking_to_sale only
--   pos_recompute_sale_status       → immutable helper; mutation RPCs only
--
-- SECURITY DEFINER callers run as postgres owner and retain access after client REVOKE.

-- ---------------------------------------------------------------------------
-- Internal helpers: no client EXECUTE
-- ---------------------------------------------------------------------------
revoke all on function public.assert_pos_manager(uuid) from public;
revoke all on function public.assert_pos_manager(uuid) from anon;
revoke all on function public.assert_pos_manager(uuid) from authenticated;

revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from public;
revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from anon;
revoke all on function public.assert_can_manage_pos_location(uuid, uuid) from authenticated;

revoke all on function public.generate_sale_reference(uuid) from public;
revoke all on function public.generate_sale_reference(uuid) from anon;
revoke all on function public.generate_sale_reference(uuid) from authenticated;

revoke all on function public.register_session_expected_minor(uuid) from public;
revoke all on function public.register_session_expected_minor(uuid) from anon;
revoke all on function public.register_session_expected_minor(uuid) from authenticated;

revoke all on function public.pos_calculate_sale_from_lines(
  uuid, uuid, text, jsonb, bigint, boolean, integer, boolean, boolean
) from public;
revoke all on function public.pos_calculate_sale_from_lines(
  uuid, uuid, text, jsonb, bigint, boolean, integer, boolean, boolean
) from anon;
revoke all on function public.pos_calculate_sale_from_lines(
  uuid, uuid, text, jsonb, bigint, boolean, integer, boolean, boolean
) from authenticated;

revoke all on function public.pos_insert_sale_lines(uuid, uuid, text, jsonb) from public;
revoke all on function public.pos_insert_sale_lines(uuid, uuid, text, jsonb) from anon;
revoke all on function public.pos_insert_sale_lines(uuid, uuid, text, jsonb) from authenticated;

revoke all on function public.pos_sale_to_jsonb(uuid) from public;
revoke all on function public.pos_sale_to_jsonb(uuid) from anon;
revoke all on function public.pos_sale_to_jsonb(uuid) from authenticated;

revoke all on function public.pos_calculate_sale_from_booking_snapshots(
  jsonb, bigint, boolean, integer, boolean
) from public;
revoke all on function public.pos_calculate_sale_from_booking_snapshots(
  jsonb, bigint, boolean, integer, boolean
) from anon;
revoke all on function public.pos_calculate_sale_from_booking_snapshots(
  jsonb, bigint, boolean, integer, boolean
) from authenticated;

revoke all on function public.pos_recompute_sale_status(bigint, bigint, bigint) from public;
revoke all on function public.pos_recompute_sale_status(bigint, bigint, bigint) from anon;
revoke all on function public.pos_recompute_sale_status(bigint, bigint, bigint) from authenticated;

-- ---------------------------------------------------------------------------
-- RLS helper: authenticated may EXECUTE (required for policy evaluation)
-- ---------------------------------------------------------------------------
revoke all on function public.is_pos_location_member(uuid, uuid) from public;
revoke all on function public.is_pos_location_member(uuid, uuid) from anon;
grant execute on function public.is_pos_location_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Approved mutation RPCs: authenticated only (re-assert after CREATE OR REPLACE defaults)
-- ---------------------------------------------------------------------------
revoke all on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) from public;
revoke all on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) from anon;
grant execute on function public.create_walk_in_sale(
  uuid, uuid, uuid, jsonb, bigint, text, text, text
) to authenticated;

revoke all on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) from public;
revoke all on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) from anon;
grant execute on function public.checkout_booking_to_sale(
  uuid, uuid, bigint, text, text, text
) to authenticated;

revoke all on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) from public;
revoke all on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) from anon;
grant execute on function public.update_open_sale(
  uuid, uuid, jsonb, bigint, text, text, text
) to authenticated;

revoke all on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) from public;
revoke all on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) from anon;
grant execute on function public.record_sale_payment(
  uuid, uuid, bigint, public.payment_method_kind, text, text, text, text
) to authenticated;

revoke all on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) from public;
revoke all on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) from anon;
grant execute on function public.refund_sale_payment(
  uuid, uuid, uuid, bigint, text, public.payment_method_kind, text
) to authenticated;

revoke all on function public.void_sale(uuid, uuid, text) from public;
revoke all on function public.void_sale(uuid, uuid, text) from anon;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;

revoke all on function public.open_register_session(uuid, uuid, bigint) from public;
revoke all on function public.open_register_session(uuid, uuid, bigint) from anon;
grant execute on function public.open_register_session(uuid, uuid, bigint) to authenticated;

revoke all on function public.close_register_session(uuid, uuid, bigint, text) from public;
revoke all on function public.close_register_session(uuid, uuid, bigint, text) from anon;
grant execute on function public.close_register_session(uuid, uuid, bigint, text) to authenticated;

revoke all on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) from public;
revoke all on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) from anon;
grant execute on function public.post_register_cash_adjustment(
  uuid, uuid, public.cash_movement_kind, bigint, text
) to authenticated;
