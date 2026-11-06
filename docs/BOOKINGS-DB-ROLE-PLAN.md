# Phase 07 — Database privilege remediation plan

**Status:** implemented (Stage 2 cutover + grant hygiene + guest RPC isolation).  
**Context:** Audit confirmed `DATABASE_URL` connects as `postgres` with `rolbypassrls=true`. Booking runtime no longer uses that pool for bookings. Guest RPCs are isolated behind `fadezy_guest_rpc`.

## 1. Final architecture

| Path | Runtime connection | Privilege boundary |
| --- | --- | --- |
| Workspace reads / writes | User-scoped Supabase client (`authenticated` + JWT) | RLS + workspace SECURITY DEFINER RPCs |
| Workspace status / busy ranges | Same client | `transition_booking_status`, `list_staff_busy_ranges` (`authenticated` EXECUTE) |
| Guest slots / create | Express → `GUEST_RPC_DATABASE_URL` (`fadezy_guest_rpc`) | EXECUTE only on two guest DEFINER RPCs; Express rate limits |
| Health / migrations / verify | `DATABASE_URL` (`postgres`) | Admin only — not booking runtime |

## 2. `fadezy_guest_rpc`

Attributes: `LOGIN` (after provision), `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, `NOREPLICATION`, `NOINHERIT`, no role memberships.

| Privilege | Value |
| --- | --- |
| CONNECT | database `postgres` |
| USAGE | schema `public` |
| EXECUTE | `guest_get_booking_slot_context`, `create_guest_booking` only |
| Table DML | **none** |

Provision password (not in SQL): `node scripts/provision-guest-rpc-role.mjs`  
Env: `GUEST_RPC_DATABASE_URL` (server-only; pooler user `fadezy_guest_rpc.<project_ref>`).

## 3. Guest RPC grants (after `20261105290000`)

| Function | `fadezy_guest_rpc` | anon | authenticated | service_role | PUBLIC |
| --- | --- | --- | --- | --- | --- |
| `guest_get_booking_slot_context` | EXECUTE | revoked | revoked | revoked | revoked |
| `create_guest_booking` | EXECUTE | revoked | revoked | revoked | revoked |

## 4. Migrations

- `20261105250000` — bookings tables / exclusion / transition
- `20261105260000` — privilege RPCs
- `20261105270000` — grant hygiene
- `20261105280000` — create `fadezy_guest_rpc` + grants (anon still executable)
- `20261105290000` — revoke anon/authenticated/service_role on guest RPCs

## 5. Stolen guest credential caveat

Express is the **intended** public HTTP entrypoint and enforces rate limiting.  
If `GUEST_RPC_DATABASE_URL` leaks and the attacker can reach the Supabase pooler/network, they can invoke **only** the two guest RPCs (still subject to slug/tenant checks inside DEFINER bodies). Mitigations: secret rotation (`provision-guest-rpc-role.mjs`), network allowlisting, monitoring. Do not claim Express is the only possible entry once DB credentials are exposed.

## 6. Rollback (guest isolation)

1. Re-grant EXECUTE on the two guest RPCs to `anon` (emergency only).
2. Temporarily point Express guest path at anon Supabase RPC **or** keep guest pool and restore grants for dual access.
3. Do **not** restore bypass-RLS `DATABASE_URL` for guest runtime.
4. Rotate `fadezy_guest_rpc` password after incident.

## 7. Remaining limitations

- DEFINER bodies run as owner (`postgres`); safety is grants + internal checks.
- `service_role` may still EXECUTE workspace RPCs (not guest); app does not use service-role booking calls.
- Default privileges on **new** public tables remain broad — re-assert grants after creates.
- Network allowlisting for the guest role is ops/infrastructure, not applied in-repo.
