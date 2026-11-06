# FADEZY OS — POS & Payments (Phase 09)

## Purpose

Location-scoped point of sale for walk-in and booking checkout sales, append-only payments/refunds, and cash register sessions. Tips, Stripe, terminals, inventory, and gift cards are out of scope for v1.

## Money

- Integer minor units + business `default_currency` only.
- Tax: optional exclusive business rate (`business_pos_tax_settings`), snapshotted on the sale.
- **Tips deferred** pending launch-market tax confirmation — not exposed in v1 APIs/UI.

## Ledger

Append-only `sale_payments` and `sale_refunds` (every refund references a payment). Sale lines immutable after first payment. Open unpaid sales editable by owner/manager via `update_open_sale`.

Statuses: `open` | `partially_paid` | `paid` | `partially_refunded` | `refunded` | `voided`.

One **non-voided** sale per booking (partial unique index). Booking status is never changed by POS.

## Register

One open session per location. Expected cash = sum of movements (`open_float` once; `close_count` excluded). Cash payments/refunds require an open session; card_manual/other do not.

## RPCs

`create_walk_in_sale`, `checkout_booking_to_sale`, `update_open_sale`, `record_sale_payment`, `refund_sale_payment`, `void_sale`, `open_register_session`, `close_register_session`, `post_register_cash_adjustment`.

Internal SECURITY DEFINER helpers (`pos_insert_sale_lines`, `pos_sale_to_jsonb`, calculators, asserts, `generate_sale_reference`, `register_session_expected_minor`) are **not** executable by `anon`/`authenticated`. Only `is_pos_location_member` remains granted to `authenticated` for RLS. Mutation RPCs remain `authenticated`-only.

`update_open_sale` persists optional `update_idempotency_key` / `update_idempotency_payload_hash` on `sales` for replay and conflict detection (same pattern as create/checkout).

## API

`/api/v1/businesses/:businessId/pos/...` — see routes in `backend/src/modules/pos/pos.routes.ts`.

## Apply / verify

```bash
node scripts/apply-pos-migrations.mjs
node scripts/verify-phase09-pos-api.mjs
node scripts/verify-phase09-pos-remediation.mjs
```
