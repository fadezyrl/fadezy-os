# Supabase setup (Phase 01)

This directory holds Supabase CLI configuration and future SQL migrations.

## Current status

- CLI config: `config.toml`
- Migrations folder: ready (`migrations/`)
- Phase 02 migration: `migrations/20261105120000_user_profiles.sql` (profiles + RLS + auth trigger)
- No business / booking / subscription tables yet
- The API reuses the existing Postgres connection via `DATABASE_URL` in `backend/.env`

## Connect your existing Supabase project

1. Create or open the project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Install the CLI globally (optional): `npm install -g supabase`
3. From the repo root, log in: `supabase login`
4. Link the project: `supabase link --project-ref <YOUR_PROJECT_REF>`
5. Copy API keys from **Project Settings → API**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only — never ship to web/mobile)
6. Copy the database URI from **Project Settings → Database** into `DATABASE_URL` (already present for this workspace).
7. Place secrets only in `backend/.env` (and public Next vars in `frontend/.env.local`).

## Security notes

- Never commit `.env` files.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` to `frontend/` or `OSMobileApp/`.
- Future multi-tenant isolation will rely on Row Level Security (RLS) policies in later phases.
