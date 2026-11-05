# FADEZY OS — Authentication (Phase 02)

## Architecture

Supabase Auth is the single identity provider for:

- Next.js web (`frontend`)
- React Native CLI app (`OSMobileApp`)
- Express REST API (`backend`)

| Client | Auth mechanism | Privileged key |
| --- | --- | --- |
| Web | `@supabase/ssr` + cookie session | Public anon/publishable only |
| Mobile | `@supabase/supabase-js` + AsyncStorage | Public anon only |
| API | `Authorization: Bearer <access_token>` verified with `supabase.auth.getUser(token)` | Anon key for verification; service role never used for ordinary auth |

Passwords and tokens must never appear in logs.

## Web flow

1. Register / login through Supabase client (`signUp` / `signInWithPassword`).
2. Email verification and password recovery use Supabase-hosted emails with redirects to `/auth/callback`.
3. `proxy.ts` (Next.js 16) refreshes the session cookies via `getUser()` / cookie `setAll`.
4. Protected UI lives under `/app`.
5. The signed-in page optionally calls `GET /api/v1/auth/me` and `POST /api/v1/auth/verify` with the access token.

## Mobile flow

1. Configure `OSMobileApp/src/config/env.ts` with the same project URL + anon key.
2. Sessions persist through AsyncStorage.
3. Deep link scheme: `fadezyos://auth/callback` (Android intent filter added).
4. Auth screens: login, register, verify email, forgot/reset password.
5. Authenticated home calls the same Express `/auth/me` endpoint.

## Backend verification

- Middleware: `backend/src/middleware/require-auth.ts`
- Uses Supabase Auth `getUser(accessToken)` — does not trust body/query user ids
- Profile reads use a user-scoped client so RLS applies
- Endpoints:
  - `GET /api/v1/auth/me`
  - `POST /api/v1/auth/verify`
- Unauthenticated requests return `401` with the shared API error envelope
- In-memory rate limiting applies to `/api/v1/auth/*`

## Session management

- Web: HTTP cookies managed by `@supabase/ssr`
- Mobile: AsyncStorage via Supabase auth storage adapter
- Access tokens refresh through Supabase client settings
- Logout clears the local session (`signOut`)

## Password recovery & email verification

Configured in the Supabase dashboard:

1. Enable email provider.
2. Set Site URL (web) and redirect allow-list (web callback + mobile deep link).
3. Keep “Confirm email” enabled — do not bypass verification in production.

## Database

Migration: `supabase/migrations/20261105120000_user_profiles.sql`

- `public.user_profiles` linked to `auth.users(id)`
- Trigger creates profile on signup (reads `full_name` from user metadata)
- RLS: authenticated users can select/update **only** their own row
- No insert/delete policies for ordinary users

Apply with Supabase CLI (`supabase db push`) or SQL editor after linking the project.

## Environment variables

### Backend (`backend/.env`)

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=   # privileged ops only; not required for ordinary auth
DATABASE_URL=                # existing pooler URL — do not replace casually
```

### Frontend (`frontend/.env.local`)

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
# alias also accepted:
# NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

### Mobile (`OSMobileApp/src/config/env.ts`)

Set `supabaseUrl` and `supabaseAnonKey` placeholders to real public values. Never add the service role key.

## Deep-link configuration

1. Supabase Auth → URL configuration: add `http://localhost:3000/auth/callback` and `fadezyos://auth/callback`.
2. Android intent filter is present for `fadezyos://auth/callback`.
3. iOS: add URL type `fadezyos` in Xcode / `Info.plist` before device recovery testing.

## Security considerations

- No service role on web/mobile
- Open redirects sanitized via allow-listed relative paths
- Cookie session refresh only through official SSR helpers
- RLS enforces profile isolation
- Future roles must not be granted from editable user metadata
- Authenticated user ≠ business owner / admin

## Status: implemented vs awaiting live config

| Area | Status |
| --- | --- |
| Shared contracts + Zod schemas | Implemented |
| Migration + RLS SQL | Implemented (not applied until you run it) |
| Backend auth middleware + endpoints | Implemented |
| Web auth pages + proxy | Implemented |
| Mobile auth screens + storage | Implemented |
| Live register/login/email delivery | **Awaiting** Supabase URL/keys + dashboard email settings |
| Live mobile deep-link recovery on device | **Awaiting** keys + iOS URL type + dashboard redirects |
