# FADEZY OS — Development guide

## Prerequisites

- Node.js `>= 22.11.0`
- npm `>= 10`
- Git
- (Optional) Supabase CLI for linking/migrations
- (Mobile) Android Studio / Xcode per React Native requirements

## Installation

From the repository root:

```bash
npm install
npm run build:shared
```

`OSMobileApp` keeps its own `node_modules`. Install separately:

```bash
cd OSMobileApp
npm install
```

## Environment configuration

1. Copy values from `.env.example`:
   - `backend/.env` — `DATABASE_URL` (existing), plus `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally `SUPABASE_SERVICE_ROLE_KEY`
   - `frontend/.env.local` — `NEXT_PUBLIC_*` including Supabase URL + anon/publishable key
2. Mobile: set public keys in `OSMobileApp/src/config/env.ts`
3. Never commit real `.env` files or the service role key to clients

### Required for API readiness

- `DATABASE_URL` (verified with a real `SELECT 1`)
- `PORT`
- `NODE_ENV`

### Required for live authentication

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (backend)
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (web)
- Mobile `mobileEnv.supabaseUrl` + `mobileEnv.supabaseAnonKey`

`SUPABASE_SERVICE_ROLE_KEY` is **not** required for ordinary user authentication.

## Authentication setup (manual)

1. Supabase Dashboard → Project Settings → API: copy URL + anon key (+ service role for server-only ops).
2. Authentication → Providers: enable Email.
3. Authentication → URL configuration:
   - Site URL: `http://localhost:3000`
   - Redirect URLs: `http://localhost:3000/auth/callback`, `fadezyos://auth/callback`
4. Apply migration `supabase/migrations/20261105120000_user_profiles.sql` via CLI or SQL editor.
5. Keep email confirmation enabled.

See `docs/AUTHENTICATION.md` for full auth architecture.

## Business onboarding (Phase 03)

1. Apply migration `supabase/migrations/20261105210000_business_multi_tenant.sql` (already applied in this workspace if you ran the script).
2. Sign in on web → `/onboarding` → create business → `/workspace/:id`.
3. Mobile: authenticated Home → Start onboarding → Workspace.

Isolation smoke tests:

```bash
node scripts/test-tenant-isolation-sql.mjs
# API-level signup test (may hit Auth rate limits):
node scripts/test-tenant-isolation.mjs
```

See `docs/BUSINESS-ONBOARDING.md`.

## Service catalog (Phase 04)

1. Apply migration:

```bash
node scripts/apply-catalog-migration.mjs
```

2. Web workspace: `/workspace/:businessId/services|categories|addons`
3. Mobile: Workspace → Services / Categories / Add-ons (API base URL must reach the host; `10.0.2.2` is emulator-only).

Isolation / catalog smoke:

```bash
node scripts/verify-phase04-catalog-sql.mjs
node scripts/verify-phase04-catalog-api.mjs
```

See `docs/SERVICE-CATALOG.md`.

## Staff & team (Phase 05)

1. Apply migration:

```bash
node scripts/apply-team-migration.mjs
```

2. Optional Resend (backend `.env`): `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `APP_PUBLIC_URL`
3. Web: `/workspace/:businessId/team`, `/invite/accept?token=...`
4. Mobile: Workspace → Team (directory)

```bash
node scripts/verify-phase05-team-sql.mjs
node scripts/verify-phase05-team-api.mjs
```

See `docs/TEAM.md`.

## Running the frontend

```bash
npm run dev:web
```

Auth routes: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/app`.

## Running the backend

```bash
npm run dev:api
```

```bash
curl http://localhost:4000/api/v1/health
curl http://localhost:4000/api/v1/health/ready
curl -i http://localhost:4000/api/v1/auth/me
```

Authenticated:

```bash
curl -H "Authorization: Bearer <access_token>" http://localhost:4000/api/v1/auth/me
```

## Running the mobile app

```bash
cd OSMobileApp
npm install
npm start
npm run android
# or
npm run ios
```

Configure `src/config/env.ts` before testing live auth.

## Supabase CLI setup

```bash
npm install -g supabase
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

## Development commands (root)

| Command | Purpose |
| --- | --- |
| `npm run dev:web` | Next.js dev server |
| `npm run dev:api` | Express API with reload |
| `npm run build:shared` | Compile `@fadezy/shared` |
| `npm run build:api` | Build shared + API |
| `npm run build:web` | Build shared + web |
| `npm run typecheck` | TypeScript across workspaces |
| `npm run lint` | ESLint for frontend + backend |

## Notes

- Preserve existing `frontend/`, `backend/`, and `OSMobileApp/` layouts.
- Do not place service-role keys in web or mobile apps.
- Phase 02 does not create businesses or dashboards.
