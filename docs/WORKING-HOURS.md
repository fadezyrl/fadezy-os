# FADEZY OS — Working hours & availability (Phase 06)

## Purpose

Foundations for business/location open hours, staff recurring schedules, breaks, time off, dated exceptions, and a read-only availability context resolver for future booking. **No appointments or slot generation.**

## Decisions

| Topic | Rule |
| --- | --- |
| Business hours | Default weekly template |
| Location hours | `inherit` \| `custom`; copy-on-create from business template |
| Staff schedules | Versioned; require assigned `location_id` (mandatory when multi-location) |
| Overnight | `end_minute > 1440` (local wall-clock) |
| Breaks | Must sit inside a working interval; `is_paid` default `false` |
| Time off | `pending` / `approved` / `rejected` / `cancelled`; staff self-request; no self-approve |
| Staff visibility | Own schedule + location hours only |
| Managers | Full schedule management across all locations |
| Resolver | `GET .../availability/context` — ingredients only |
| TZ library | Luxon |

## Precedence

1. Location closed exception  
2. Location special hours  
3. Location weekly (or inherited business weekly)  
4. Approved time off subtracts from staff windows  
5. Staff weekly version effective on date (location-filtered)  
6. Subtract breaks  
7. Intersect with location open windows  

## Migration

`supabase/migrations/20261105240000_working_hours.sql`

Apply: `node scripts/apply-schedule-migration.mjs`

## API (under `/api/v1/businesses/:businessId`)

- `GET/PUT /operating-hours`
- `GET/PUT /locations/:locationId/operating-hours`
- `GET/POST /schedule-exceptions`, `POST .../:id/cancel`
- `GET/PUT /members/:memberId/schedules`
- `GET/POST /time-off`, `POST .../:id/approve|reject|cancel`
- `GET /availability/context?date=&locationId=&membershipId=`
- `GET /schedule/permissions`

## Clients

- Web: `/workspace/:businessId/schedule`
- Mobile: Workspace → Schedule (view hours/own schedule + request time off)
