# FADEZY OS — Booking engine (Phase 07)

## Purpose

Workspace and guest booking APIs with server-side slot generation, booking-aware availability, snapshots, and database-level double-booking prevention. Payments, deposits, POS, multi-service bookings, and polished public widgets are out of scope.

## Data model

| Table | Role |
| --- | --- |
| `customers` | Business-scoped CRM (no `auth.users` link; email not unique). Phase 08 directory/detail/archive — see `docs/CUSTOMERS.md` |
| `bookings` | Appointment + busy range + snapshots + idempotency |
| `booking_services` | Primary service line snapshot |
| `booking_addons` | Optional add-on line snapshots |
| `booking_status_events` | Status / reschedule audit trail |

Busy occupancy uses half-open `tstzrange(busy_starts_at, busy_ends_at, '[)')` with GiST exclusion on `staff_membership_id` for rows where `status = 'confirmed'`.

Busy range = appointment start − before buffer through appointment end + after buffer. Appointment duration includes service duration, processing time (blocking in V1), and add-on durations.

## Lifecycle

Statuses: `confirmed` → `completed` | `cancelled` | `no_show`.

- Workspace and guest creates land in `confirmed` immediately (no holds/TTL).
- Terminal states are not casually reopened.
- Reschedule keeps `confirmed` and writes an audit event with previous times.
- Cancelled / completed / no-show release occupancy (exclusion applies only to `confirmed`).

## Slot generation

1. Resolve Phase 06 availability windows for location + staff + local date.
2. Subtract confirmed busy minute blocks for that staff.
3. Fit occupied length (buffers + appointment) inside free windows.
4. Emit starts on a **5-minute** grid (`DEFAULT_SLOT_INTERVAL_MINUTES`, internally configurable).
5. Revalidate offered slots immediately before insert.

Clients never supply authoritative `ends_at` or busy bounds.

## Availability integration

Reuses `resolveAvailabilityContextInternal` (user-scoped Supabase client + RLS / existing schedule RPCs) for authenticated workspace flows. Guest/public flows call `guest_get_booking_slot_context` (SECURITY DEFINER, EXECUTE for `anon`/`authenticated`) and generate slots in Node — no bypass-RLS pool and no anon table grants.

## Timezone / DST

- Instants stored as `timestamptz`.
- Location IANA timezone snapshotted on the booking.
- Display uses location timezone.
- Local conversion reuses Phase 06 Luxon gap/fold behavior.

## Conflict prevention

- Application pre-check (slot membership) plus PostgreSQL `EXCLUDE USING gist`.
- Concurrent inserts for the same staff/busy overlap: one succeeds, others map to `409 BOOKING_CONFLICT`.
- Reschedule updates busy range atomically inside a transaction (self excluded from slot occupancy).

## Permissions

| Role | Capability |
| --- | --- |
| Owner / manager | All locations |
| Staff | Assigned locations only; no business config |
| Guest | Public create/slots only via rate-limited Express; no direct DB writes |

RLS: members can select bookings/customers per policy under the JWT role. Create/reschedule mutations use SECURITY DEFINER RPCs (`create_workspace_booking`, `reschedule_booking_times`, `create_guest_booking`) that re-check authorization inside Postgres. Status transitions use `transition_booking_status`. Runtime booking code does not use `DATABASE_URL` / `rolbypassrls`.

## API contracts

Authenticated (`/api/v1/businesses/:businessId`):

- `GET /bookings/permissions`
- Customer CRM routes (`GET|POST|PATCH /customers…`) — see `docs/CUSTOMERS.md`
- `GET /booking-slots`
- `GET|POST /bookings` — day agenda `date` requires `locationId`; bounds are that location’s local `[D, D+1)` converted to UTC (DST-safe), then paginated
- `GET /bookings/:bookingId`
- `POST /bookings/:bookingId/cancel|complete|no-show|reschedule`

Public guest (`/api/v1/public/booking`, rate-limited):

- `GET /slots?businessSlug&date&locationId&serviceId&staffMembershipId&addonIds`
- `POST /bookings` with `businessSlug`, customer details, `idempotencyKey`

Idempotency: same key + same payload returns original booking; same key + different payload → `409 CONFLICT`.

## Guest behavior

- No Fadezy Auth account required.
- Must use `is_bookable_online` services.
- Always creates/associates a business-scoped customer via server path.
- Polished public booking page deferred to Phase 14.

## Database privileges (remediation)

Migration: `supabase/migrations/20261105260000_booking_privilege_rpcs.sql`

| Function | Owner | SECURITY DEFINER | EXECUTE |
| --- | --- | --- | --- |
| `assert_can_manage_booking_location` | postgres | yes | none for anon/authenticated (internal) |
| `create_workspace_booking` | postgres | yes | `authenticated` only; rejects archived `p_customer_id` (`CUSTOMER_ARCHIVED`) |
| `reschedule_booking_times` | postgres | yes | `authenticated` only |
| `guest_get_booking_slot_context` | postgres | yes | `fadezy_guest_rpc` only |
| `create_guest_booking` | postgres | yes | `fadezy_guest_rpc` only |

All set `search_path = public`. Guest RPCs resolve business from slug, reject foreign location/service/staff, never accept customer IDs, and return a public-safe JSON subset (no email/phone/customer id).

Express guest routes use server-only `GUEST_RPC_DATABASE_URL` (`backend/src/db/guest-rpc-pg.ts`). Provision: `node scripts/provision-guest-rpc-role.mjs`.

Apply: `node scripts/apply-booking-privilege-migration.mjs`  
Verify: `node scripts/verify-phase07-booking-privilege.mjs`

### Grant hygiene (`20261105270000`)

| Object | Retained | Revoked |
| --- | --- | --- |
| `list_staff_busy_ranges` | EXECUTE `authenticated` | `anon`, `PUBLIC` |
| `transition_booking_status` | EXECUTE `authenticated` | `anon`, `PUBLIC` |
| `bookings`, `booking_services`, `booking_addons`, `booking_status_events` | SELECT `authenticated` | all other authenticated DML/TRUNCATE; all `anon` |
| `customers` | SELECT/INSERT/UPDATE `authenticated` (RLS) | DELETE/TRUNCATE/etc.; all `anon` |

Apply: `node scripts/apply-booking-grant-hygiene-migration.mjs`

### Guest RPC isolation (`20261105280000` + `20261105290000`)

1. Create `fadezy_guest_rpc` (NOBYPASSRLS, no table grants) + EXECUTE on the two guest RPCs.
2. Wire Express to `GUEST_RPC_DATABASE_URL` and verify.
3. Revoke EXECUTE from `anon`, `authenticated`, and `service_role` on those RPCs.

PostgREST with the public anon key can no longer call guest booking RPCs. Express remains the intended public HTTP path with rate limiting. A stolen `GUEST_RPC_DATABASE_URL` can still invoke the two RPCs if the DB is reachable — rotate via the provision script; see `docs/BOOKINGS-DB-ROLE-PLAN.md`.

### Rollback (emergency)

1. Revert backend booking module to the prior pool-based revision (restores `availability-pg` + `getPgPool` usage).
2. Drop or replace the privilege RPCs if needed: `drop function if exists public.create_guest_booking(...);` (and siblings) — keep `20261105250000` tables.
3. Restore `DATABASE_URL` as the booking write path only as break-glass (still `rolbypassrls=true`); do not treat that as normal operation.

## Migration

- `supabase/migrations/20261105250000_bookings.sql` — tables / exclusion / transition RPC
- `supabase/migrations/20261105260000_booking_privilege_rpcs.sql` — privilege RPCs
- `supabase/migrations/20261105270000_booking_grant_hygiene.sql` — grant hygiene
- `supabase/migrations/20261105280000_guest_rpc_role.sql` — `fadezy_guest_rpc` role + grants
- `supabase/migrations/20261105290000_guest_rpc_revoke_anon.sql` — revoke public guest EXECUTE

Apply in order; then `node scripts/provision-guest-rpc-role.mjs` for `GUEST_RPC_DATABASE_URL`.

Verify: `node scripts/verify-phase07-bookings-sql.mjs`, `node scripts/verify-phase07-bookings-api.mjs`, `node scripts/verify-phase07-booking-privilege.mjs`
