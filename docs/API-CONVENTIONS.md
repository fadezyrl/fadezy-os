# FADEZY OS — API conventions (Phase 01)

## Versioning

- All HTTP endpoints are prefixed with `/api/v1`.
- Breaking changes require a new version prefix (`/api/v2`, etc.).
- The shared constant `API_VERSION_PREFIX` must stay aligned with route registration.

## Clients

The same REST API serves:

- Next.js web (`frontend`)
- React Native (`OSMobileApp`)
- Future first-party clients

Do not add web-only response shapes without a mobile-compatible alternative.

## Success response

```json
{
  "success": true,
  "data": {},
  "message": "optional"
}
```

## Error response

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable summary",
    "details": {}
  }
}
```

Use codes from `@fadezy/shared` (`API_ERROR_CODES`) when possible.

## HTTP status usage

| Status | When |
| --- | --- |
| 200 | Successful read / action |
| 201 | Resource created (future) |
| 400 | Malformed request (future use) |
| 401 | Authentication required (future) |
| 403 | Authenticated but not allowed (future) |
| 404 | Unknown route or resource |
| 422 | Validation failure |
| 500 | Unexpected server error |
| 503 | Readiness failed |

## Validation

- Validate request `body` / `query` / `params` with Zod via `validateRequest`.
- Return `422` + `VALIDATION_ERROR` with field-level `details`.
- Never trust client input for authorization decisions.

## Health endpoints

### `GET /api/v1/health`

Liveness. Returns service name, version, and `status: "ok"`.

### `GET /api/v1/health/ready`

Readiness. Verifies required environment variables and performs a real database ping using `DATABASE_URL`. Returns `503` when not ready. Does not claim database success without a successful query.

## Authentication

Protected routes require `Authorization: Bearer <access_token>`.

The API verifies identity with Supabase Auth `getUser(token)` and attaches `req.auth`.

Unauthenticated requests receive `401`. Missing Supabase configuration returns `503`.

## Business / tenant APIs (Phase 03)

- `GET/POST /api/v1/businesses`
- `GET/PATCH /api/v1/businesses/:businessId`
- `GET/POST /api/v1/businesses/:businessId/locations`
- `GET /api/v1/businesses/:businessId/onboarding`
- `GET/PUT /api/v1/businesses/onboarding-draft`

Business creation is atomic via Postgres RPC. Owner is derived from `auth.uid()`, never from client payload.

## Service catalog APIs (Phase 04)

Under `/api/v1/businesses/:businessId`:

- `GET/POST /service-categories`, `GET/PATCH/DELETE /service-categories/:categoryId`, `POST /service-categories/reorder`
- `GET/POST /services`, `GET/PATCH/DELETE /services/:serviceId`, `POST /services/reorder`
- `PUT /services/:serviceId/locations`, `PUT /services/:serviceId/addons`
- `GET/POST /service-addons`, `PATCH/DELETE /service-addons/:addonId`

`DELETE` soft-archives. Money uses integer `priceMinor` + ISO 4217 `currency` (snapshotted from the business). See `docs/SERVICE-CATALOG.md`.

Owners and managers may mutate; staff are read-only; RLS is authoritative.

## Team APIs (Phase 05)

Under `/api/v1/businesses/:businessId`:

- `GET /members`, `GET /members/permissions`, `GET /members/:memberId`
- `PATCH /members/:memberId/profile`, `/role`, `/status`
- `PUT /members/:memberId/locations`, `/services`
- `GET/POST /invitations`, `POST /invitations/:invitationId/cancel|resend`

Accept (authenticated): `POST /api/v1/invitations/accept` with `{ "token": "..." }`.

See `docs/TEAM.md`. Invitation tokens are hashed at rest; accept uses `auth.uid()` only.

## Localization expectations

Request/response payloads that carry money, dates, or phone numbers should eventually include explicit currency, timezone, locale, and E.164 phone fields rather than assuming a single market default.
