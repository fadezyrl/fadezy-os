# FADEZY OS

International multi-tenant SaaS platform for barbershops and beauty salons.

Phase 01 establishes the project foundation: Next.js web shell, Express REST API, shared contracts, Supabase preparation, and documentation. Existing `frontend/`, `backend/`, and `OSMobileApp/` projects are preserved.

## Stack

- **Web:** Next.js (App Router), React, TypeScript, Tailwind CSS
- **API:** Node.js, Express, TypeScript
- **Data:** Supabase PostgreSQL (existing `DATABASE_URL`), Supabase Auth/Storage later
- **Mobile:** React Native (`OSMobileApp`, separate install)
- **Monorepo:** npm workspaces (`frontend`, `backend`, `packages/shared`)

## Quick start

```bash
npm install
npm run build:shared

# terminal 1
npm run dev:api

# terminal 2
npm run dev:web
```

- Web: http://localhost:3000
- API health: http://localhost:4000/api/v1/health
- API ready: http://localhost:4000/api/v1/health/ready

## Environment

1. See `.env.example` for the full variable list.
2. Server secrets live in `backend/.env` (already contains `DATABASE_URL` for this workspace).
3. Public web vars live in `frontend/.env.local` (`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, Supabase public keys).
4. Never commit secrets. Never put `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` in web/mobile clients.
5. Ordinary authentication uses the anon/publishable key. Service role is optional and server-only.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Business onboarding](docs/BUSINESS-ONBOARDING.md)
- [API conventions](docs/API-CONVENTIONS.md)
- [Supabase setup](supabase/README.md)

## Workspace scripts

| Script | Description |
| --- | --- |
| `npm run dev:web` | Start Next.js |
| `npm run dev:api` | Start Express API |
| `npm run typecheck` | TypeScript checks |
| `npm run lint` | ESLint |
| `npm run build` | Build shared, API, and web |

## Mobile

```bash
cd OSMobileApp
npm install
npm start
```

Configure the API base URL in `OSMobileApp/src/config/api.ts`.
