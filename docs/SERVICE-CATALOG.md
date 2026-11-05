# FADEZY OS — Service catalog (Phase 04)

## Purpose

Business-scoped service categories, services, add-ons, and location availability/pricing.
Foundational for later booking, POS, and websites. **No booking engine in this phase.**

## Money model

- Prices are stored as **integer minor units** (`price_minor` / `priceMinor`) plus an explicit **ISO 4217** `currency` code.
- On create, currency is **snapshotted** from `businesses.default_currency`.
- Location overrides must use the **same currency** as the service (enforced in DB trigger + API).
- No silent FX conversion. Changing currency on an existing service/add-on is rejected.
- Zero-decimal currencies (e.g. JPY, KRW) are handled via `currencyMinorDigits()` in `@fadezy/shared`. Do not assume every currency has two decimals.

## Soft archive

- `DELETE` endpoints **archive** (`archived_at`, `is_active=false`). Rows are retained.
- Category archive with active services requires explicit `forceWithServices` or `reassignServicesToCategoryId`.
- Service–addon links and location settings are not wiped when archiving a service or add-on (links remain for history; UI hides archived entities by default).

## Authorization

| Role | Catalog |
| --- | --- |
| Owner | Full manage |
| Manager | Full manage |
| Staff | Read-only |
| Non-member | No access (RLS) |

Ultimate enforcement: PostgreSQL RLS via `is_business_member` / `is_business_catalog_editor`.

## Schema

Tables: `service_categories`, `services`, `service_location_settings`, `service_addons`, `service_addon_links`.

Migration: `supabase/migrations/20261105220000_service_catalog.sql`.

Apply: `node scripts/apply-catalog-migration.mjs`

Rollback considerations: drop policies then tables in reverse dependency order (`service_addon_links` → `service_location_settings` → `services`/`service_addons` → `service_categories` → helper function). Does not touch Phase 03 tables.

## API (under `/api/v1/businesses/:businessId`)

- Categories: `GET/POST /service-categories`, `GET/PATCH/DELETE /service-categories/:id`, `POST /service-categories/reorder`
- Services: `GET/POST /services`, `GET/PATCH/DELETE /services/:id`, `POST /services/reorder`, `PUT /services/:id/locations`, `PUT /services/:id/addons`
- Add-ons: `GET/POST /service-addons`, `PATCH/DELETE /service-addons/:id`

List services support `q`, `categoryId`, `status`, `locationId`, `limit` (default 50), `offset`.

## Duration fields

- `durationMinutes` — service length
- `processingMinutes` — optional processing gap
- `bufferBeforeMinutes` / `bufferAfterMinutes` — scheduling buffers (foundation only)

## Known limitations

- Images are `image_url` only (no Storage upload).
- Mobile: services/categories CRUD, add-ons list, simple primary-location price override. Full add-on create/reorder UX is stronger on web.
- Physical Android devices need a reachable `apiBaseUrl` (not emulator-only `10.0.2.2`).
