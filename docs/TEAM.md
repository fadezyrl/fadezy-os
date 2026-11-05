# FADEZY OS — Staff & team (Phase 05)

## Purpose

Invite and manage people across businesses without creating duplicate Auth identities. Membership remains the tenant link; invitations hold pre-accept state; staff profiles hold directory and employment fields.

## Decisions

| Topic | Rule |
| --- | --- |
| Invite roles | Owners invite managers + staff. Managers invite staff only. Never invite as owner. |
| Locations | Location create/edit/delete stays owner-only (Phase 03). Managers may assign staff to existing locations. |
| Email | Resend transactional invitations. Empty `RESEND_API_KEY` skips send (logs domain only, never raw tokens). |
| Eligibility | `staff_service_assignments` M:N for staff ↔ service. |
| Removal | Soft: `membership_status=suspended` and/or `deactivated_at`. History preserved. |
| Staff directory | Active teammates see basic public fields. Internal notes / private fields filtered in API for staff. |

## Security

- One Supabase Auth user per person across businesses.
- Accept RPC uses `auth.uid()` only — never creates Auth users in SQL.
- Accept requires verified email matching the invitation.
- Invitation tokens: raw token emailed once; only SHA-256 `token_hash` stored. Never log raw tokens.
- Last active owner cannot be demoted, suspended, or deactivated (`LAST_OWNER_PROTECTED`).
- Permissions enforced in Express + SECURITY DEFINER RPCs + RLS.
- Service-role key stays off web/mobile clients.

## Schema

Migration: `supabase/migrations/20261105230000_staff_team.sql`

- Extends `business_members` with lifecycle columns (`invited_at`, `accepted_at`, `suspended_at`, `deactivated_at`, `invited_by`)
- `business_invitations` (hashed tokens, pending uniqueness per email)
- `staff_profiles`
- `staff_location_assignments`, `staff_service_assignments`
- RPCs: `create_business_invitation`, `accept_business_invitation`, `cancel_business_invitation`, `update_business_member_role`, `update_business_member_status`, `set_staff_locations`, `set_staff_services`
- Updates `create_business_with_owner` to seed owner `staff_profiles`
- Backfills profiles for existing members

Apply: `node scripts/apply-team-migration.mjs`

## API

Under `/api/v1/businesses/:businessId`:

- `GET /members`, `GET /members/permissions`, `GET /members/:memberId`
- `PATCH /members/:memberId/profile|role|status`
- `PUT /members/:memberId/locations|services`
- `GET/POST /invitations`, `POST /invitations/:id/cancel|resend`

Global (auth required):

- `POST /api/v1/invitations/accept` `{ "token": "..." }`

## Clients

- Web: `/workspace/:businessId/team`, member detail, `/invite/accept?token=...`
- Mobile: Team list + member detail (directory). Invite/management UX is web-first.

## Env (backend)

```
RESEND_API_KEY=
RESEND_FROM_EMAIL=Fadezy OS <onboarding@resend.dev>
APP_PUBLIC_URL=http://localhost:3000
```

## Known limitations

- Invitation email delivery is only verified when Resend is configured and a real send succeeds.
- Staff privacy for `internal_notes` is enforced in the API response layer; clients must use the REST API (not direct table select for private fields).
- Mobile does not yet include invite/resend/role management screens.
