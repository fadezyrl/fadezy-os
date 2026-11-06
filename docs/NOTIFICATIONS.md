# FADEZY OS — Notifications (Phase 10)

## Scope (v1)

- Transactional outbox for booking lifecycle, fixed 24h reminders, time-off, and optional POS in-app events
- Channels: Resend email + web in-app inbox
- Staff operational preferences (email **default OFF**, in-app **default ON**)
- Customer booking emails when an address exists (production enablement subject to launch-market compliance review)
- Invitations remain on the existing **synchronous** Resend path (no sealed invitation outbox in v1)

## Delivery semantics

Delivery is **at-least-once**. The worker may retry after crashes or expired leases. Resend `Idempotency-Key` = delivery id mitigates duplicate provider accepts; this is **not** a universal exactly-once guarantee.

## Capture model

Business mutations and notification capture commit in the **same Postgres transaction**:

- `booking_status_events` AFTER INSERT → `notify_on_booking_status_event`
- `sale_events` AFTER INSERT → `notify_on_sale_event` (in-app oriented)
- Time-off create uses `create_staff_time_off_request` (atomic emit)
- Time-off approve/reject emit inside `review_staff_time_off`

Internal helpers (`emit_notification_event`, reminder schedule/cancel) are **not** executable by `PUBLIC`, `anon`, or `authenticated`.

## Reminder timing

`fire_at = starts_at - interval '24 hours'` (absolute timestamptz). Location IANA timezone is used for presentation in templates. Reschedule/cancel/complete/no-show cancel eligible scheduled reminders and pending/failed reminder deliveries via `cancel_booking_reminder_state` (row locks schedules first).

Reschedule notification idempotency keys use `booking.rescheduled:{booking_status_events.id}` so A→B→A still emits distinct events.

Reminder schedule rows use a starts_at-scoped idempotency key. After cancel, re-scheduling the same starts_at (A→B→A) reactivates a cancelled row via `ON CONFLICT … DO UPDATE` rather than leaving zero scheduled reminders.

## Worker role

| Item | Value |
|------|--------|
| Role | `fadezy_notify_worker` (login, no superuser, no bypass RLS) |
| Connection | `NOTIFY_WORKER_DATABASE_URL` only — never `DATABASE_URL` |
| Privileges | EXECUTE on worker RPCs only — **no** arbitrary table DML |
| Provision | `node scripts/provision-notify-worker-role.mjs` |

Worker RPCs:

- `release_expired_delivery_leases`
- `claim_notification_deliveries(limit, worker_id)` — `FOR UPDATE SKIP LOCKED` + lease
- `worker_get_delivery_payload(delivery_id, worker_id)` — requires active lease owned by `worker_id`
- `complete_notification_delivery` / `fail_notification_delivery` / `skip_notification_delivery` — each takes `worker_id` and rejects non-owners / expired / non-processing
- `materialize_due_notification_schedules`

`booking.reminder.24h` creates **customer email only** (no staff or owner/manager in-app/email copies).

### Payment-path latency note

Phase 10’s `AFTER INSERT` trigger on `sale_events` runs `emit_notification_event` inside the same transaction as `record_sale_payment` (and create/refund/void). That adds outbox work while the sale row lock is held. Latency is acceptable for v1 volume; financial rules and locks are unchanged. Concurrent edit-vs-pay may serialize either way; both outcomes remain valid under product rules when the payment amount is within the outstanding balance.

## Express APIs

Under `/api/v1/businesses/:businessId` (auth required, membership checked):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/notifications` | Own in-app inbox |
| POST | `/notifications/:id/read` | Mark read/unread |
| GET | `/notification-preferences` | Expanded staff prefs with defaults |
| PATCH | `/notification-preferences` | Upsert own prefs |

There is **no** client API to send arbitrary notifications.

## Worker process (Render)

Dedicated **Background Worker** service:

- Build: `npm run build -w @fadezy/shared && npm run build -w backend`
- Start: `npm run start:notify-worker -w backend`
- Env: `NOTIFY_WORKER_DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `APP_PUBLIC_URL`
- Optional: `NOTIFY_WORKER_POLL_MS` (default 5000)

Local: `npm run dev:notify-worker`

## UI

`/workspace/:businessId/notifications` — inbox + staff preference toggles.

## Verification

```bash
node scripts/apply-notifications-migrations.mjs
node scripts/provision-notify-worker-role.mjs
node scripts/verify-phase10-notifications.mjs
```

Also re-run Phase 06–09 regression scripts after deploy.
