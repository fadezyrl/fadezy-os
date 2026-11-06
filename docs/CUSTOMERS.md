# FADEZY OS — Customer CRM (Phase 08)

## Purpose

Web workspace CRM for business-scoped customers: directory, profile edit, soft archive/restore, and visit history from existing bookings. Tags, merge, loyalty, marketing, customer portal, and mobile CRM are out of scope.

## Data model

Reuses `public.customers` from Phase 07:

| Column | Notes |
| --- | --- |
| `business_id` | Tenant scope |
| `full_name`, `email`, `phone`, `notes` | Editable profile; email/phone not unique |
| `archived_at` | Soft archive |

Bookings keep `customer_id` (`ON DELETE RESTRICT`) plus immutable snapshots `customer_name` / `customer_email` / `customer_phone`. Profile edits never rewrite snapshots.

Index for visit history: `bookings_customer_starts_idx` on `(customer_id, starts_at DESC, id DESC)`.

## Archive semantics

- Archive sets `archived_at`; restore clears it (both idempotent).
- Default directory and booking composer list `status=active` only.
- Archived detail returns HTTP 200 with banner; profile edit remains allowed.
- New workspace bookings with an archived `customerId` are rejected inside `create_workspace_booking` (`CUSTOMER_ARCHIVED`).
- Existing bookings are unchanged after archive.
- Guest create always inserts a new active customer (unchanged).

## Permissions

Customer RLS: any active business member may SELECT / INSERT / UPDATE. No DELETE grant.

Visit history uses booking SELECT RLS: owner/manager see all locations; staff see assigned locations only.

## API (`/api/v1/businesses/:businessId`)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/customers` | `q`, `status=active\|archived\|all`, `limit`, `offset` → `{ items, meta }` |
| `POST` | `/customers` | Create |
| `GET` | `/customers/:customerId` | Detail (incl. archived) |
| `PATCH` | `/customers/:customerId` | Profile fields |
| `POST` | `/customers/:customerId/archive` | Soft archive |
| `POST` | `/customers/:customerId/restore` | Restore |
| `GET` | `/customers/:customerId/bookings` | Visit history, newest first |

All ordinary CRM operations use the user-scoped Supabase client (no bypass-RLS).

Archived booking attempt: HTTP **422** with `error.code = CUSTOMER_ARCHIVED`.

## UI

- `/workspace/[businessId]/customers` — directory
- `/workspace/[businessId]/customers/[customerId]` — detail + history
- Booking composer uses paginated active list; optional `?customerId=` deep-link from detail

## Migration

`supabase/migrations/20261106100000_customers_crm.sql`

Apply: `node scripts/apply-customers-crm-migration.mjs`  
Verify: `node scripts/verify-phase08-customers-api.mjs`
