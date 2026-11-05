# FADEZY OS — Business onboarding & multi-tenant architecture (Phase 03)

## Onboarding flow

1. Business type (`barbershop` | `beauty_salon`)
2. Business information + editable slug
3. Country / currency / timezone / locale
4. Primary location
5. Review + atomic create
6. Workspace shell

Draft progress is persisted in `business_onboarding_drafts` (server-side). Final creation is atomic.

## Entity model

- `businesses` — tenant root
- `business_members` — user ↔ business membership + role
- `business_locations` — multi-location support, one primary per business
- `business_onboarding_drafts` — resume incomplete onboarding before create

User accounts (`auth.users` / `user_profiles`) remain separate from businesses.

## Ownership & roles

Initial roles: `owner`, `manager`, `staff`.

Phase 03 assigns **only** `owner` during creation.

Owner is derived from `auth.uid()` inside `create_business_with_owner(jsonb)`.
Clients cannot supply `owner_id` or escalate roles through ordinary inserts/updates.

## International settings

Country, currency, timezone, and locale are explicit fields.
Suggestions come from curated option lists; nothing is locked to one market.

## Security / tenant isolation

1. RLS enabled on all tenant tables.
2. `is_business_member(business_id)` / `is_business_owner(business_id)` helpers.
3. Members can read only their businesses/locations/memberships.
4. Owners can update business profile and add locations.
5. No client insert into `businesses` or `business_members` (RPC only).
6. Express APIs use verified Bearer tokens + user-scoped Supabase client (RLS still applies).

## Atomic create RPC

`public.create_business_with_owner(payload jsonb)`:

- requires `auth.uid()`
- inserts business
- inserts owner membership for `auth.uid()`
- inserts primary location
- clears onboarding draft
- supports idempotent replay via `client_request_id`

## APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/businesses` | List accessible businesses |
| POST | `/api/v1/businesses` | Atomic create |
| GET | `/api/v1/businesses/:id` | Get one (membership required) |
| PATCH | `/api/v1/businesses/:id` | Owner update |
| GET | `/api/v1/businesses/:id/locations` | List locations |
| POST | `/api/v1/businesses/:id/locations` | Owner add location |
| GET | `/api/v1/businesses/:id/onboarding` | Onboarding state |
| GET/PUT | `/api/v1/businesses/onboarding-draft` | Draft resume |

## Mobile keys note

`OSMobileApp/src/config/env.ts` currently stores public Supabase keys in source for local development.
This is **not ideal**. Prefer non-committed env injection later.
Never place the service role key in mobile source. Do not log these values.

## Apply migration

```bash
# via Supabase SQL editor, or:
psql "$DATABASE_URL" -f supabase/migrations/20261105210000_business_multi_tenant.sql
```

Phase 02 `user_profiles` migration must already be applied.
