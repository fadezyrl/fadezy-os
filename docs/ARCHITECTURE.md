# FADEZY OS — Architecture (Phase 01)

## Overview

FADEZY OS is an international, multi-tenant SaaS platform for barbershops and beauty salons.

- Phase 01: foundation (web/API shell, shared contracts, Supabase prep)
- Phase 02: authentication & identity
- Phase 03: business onboarding & multi-tenant tenancy (`businesses`, memberships, locations, RLS)
- Phase 04: service catalog (categories, services, add-ons, location pricing; soft-archive; minor-unit money)
- Phase 05: staff & team (invitations via Resend, staff profiles, location/service eligibility, soft removal)
- Phase 06: working hours & availability foundations (Luxon TZ/DST, schedules, time off, context resolver; no booking)
- Phase 07: booking engine (workspace + guest, snapshots, GiST exclusion, privilege-hardened RPCs)
- Phase 08: customer CRM (directory, profile edit, soft archive, visit history; see `docs/CUSTOMERS.md`)
- Phase 09: POS & payments (sales ledger, register sessions; tips deferred; see `docs/POS.md`)
- Phase 10: Notifications (transactional outbox, Resend + in-app inbox, restricted worker; see `docs/NOTIFICATIONS.md`)

## Repository layout

```text
fadezy-os/
├── frontend/          # Next.js (App Router) web client
├── backend/           # Express.js TypeScript REST API
├── OSMobileApp/       # React Native client (independent tooling)
├── packages/shared/   # Shared API types and international contracts
├── supabase/          # Supabase CLI config + future migrations
└── docs/              # Architecture and development documentation
```

Existing `frontend/`, `backend/`, and `OSMobileApp/` folders are preserved. Phase 01 does **not** force an `apps/web` + `apps/api` rename.

Root npm workspaces include `frontend`, `backend`, and `packages/*`. `OSMobileApp` remains outside workspaces to avoid breaking React Native Metro resolution.

## Frontend / backend separation

| Layer | Responsibility |
| --- | --- |
| `frontend` | UI, public env (`NEXT_PUBLIC_*`), calls REST API |
| `backend` | Auth-ready API surface, validation, Supabase/Postgres access |
| `OSMobileApp` | Native clients consuming the same REST contracts |
| `@fadezy/shared` | Shared response types and international foundations |

The frontend never receives `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL`.

## Shared package

`@fadezy/shared` provides:

- Canonical API success/error envelopes
- Health / readiness data contracts
- International type foundations (country, currency, locale, timezone, phone)
- API version prefix and error code constants

Both web and API import these types so contracts are not duplicated.

## Supabase integration

- Postgres access today: `DATABASE_URL` in `backend/.env` (existing Supabase connection)
- Future Auth / Storage: configured via `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Server clients live in `backend/src/config/supabase.ts`
- Migrations live in `supabase/migrations/` (profiles, multi-tenant businesses, service catalog, staff/team)

## API communication

- Base path: `/api/v1`
- JSON envelopes from `@fadezy/shared`
- Web uses `NEXT_PUBLIC_API_URL`
- Mobile should use the same base URL and envelope (see `OSMobileApp/src/config/api.ts`)

## Future mobile compatibility

The API is client-independent:

- No browser-only session assumptions in Phase 01
- CORS allowlist applies to browser origins; native apps typically send no `Origin` and are allowed
- Shared response types keep web and mobile aligned
- Future auth will issue tokens usable by web and mobile against the same routes

## International SaaS foundations

Architecture assumes multiple countries, currencies, time zones, languages, phone formats, and business locations. Defaults are not locked to a single market. Role keys in shared constants are open-ended for later RBAC.

## Security posture (Phase 01)

- Strict env parsing in the API
- Helmet security headers
- CORS allowlist
- 1mb payload limits
- Centralized errors without leaking secrets
- Structured logs with sensitive-key redaction
- Service role key server-only
- Prepared for future tenant isolation via Supabase RLS
