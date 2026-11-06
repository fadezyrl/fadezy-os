/**
 * Phase 10 notification delivery worker (Render Background Worker).
 *
 * Delivery is at-least-once. Resend Idempotency-Key = delivery id mitigates
 * duplicate accepts after crash-before-complete — not a universal exactly-once guarantee.
 *
 * Uses NOTIFY_WORKER_DATABASE_URL only — never DATABASE_URL.
 * Complete/fail/skip/payload require matching lease_owner (p_worker_id).
 */
import { randomUUID } from 'node:crypto';
import { notifyWorkerQuery } from '../db/notify-worker-pg';
import {
  EmailDeliveryError,
  renderBookingCustomerEmail,
  renderGenericStaffEmail,
  sendTransactionalEmail,
} from '../services/email';
import { logger } from '../utils/logger';

type DeliveryRow = {
  id: string;
  event_id: string;
  business_id: string;
  channel: string;
  template_key: string;
  recipient_user_id: string | null;
  to_email: string | null;
  attempt_count: number;
};

const workerId = `notify-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Number(process.env.NOTIFY_WORKER_POLL_MS ?? 5000);

async function tick(): Promise<void> {
  await notifyWorkerQuery(`select public.release_expired_delivery_leases()`);
  await notifyWorkerQuery(`select public.materialize_due_notification_schedules($1)`, [25]);

  const { rows } = await notifyWorkerQuery<DeliveryRow>(
    `select * from public.claim_notification_deliveries($1, $2)`,
    [20, workerId],
  );

  for (const delivery of rows) {
    if (delivery.channel !== 'email' || !delivery.to_email) {
      await notifyWorkerQuery(`select public.skip_notification_delivery($1, $2, $3)`, [
        delivery.id,
        'unsupported_channel',
        workerId,
      ]);
      continue;
    }

    try {
      const { rows: payloadRows } = await notifyWorkerQuery<{
        payload: Record<string, unknown>;
      }>(`select public.worker_get_delivery_payload($1, $2) as payload`, [
        delivery.id,
        workerId,
      ]);
      const payload = (payloadRows[0]?.payload ?? {}) as Record<string, unknown>;

      const rendered = delivery.template_key.includes('customer')
        ? renderBookingCustomerEmail(delivery.template_key, payload)
        : renderGenericStaffEmail(delivery.template_key, payload);

      const result = await sendTransactionalEmail({
        to: delivery.to_email,
        subject: rendered.subject,
        html: rendered.html,
        idempotencyKey: delivery.id,
      });

      if (result.skipped) {
        await notifyWorkerQuery(`select public.skip_notification_delivery($1, $2, $3)`, [
          delivery.id,
          'provider_unconfigured',
          workerId,
        ]);
        continue;
      }

      await notifyWorkerQuery(`select public.complete_notification_delivery($1, $2, $3)`, [
        delivery.id,
        result.providerMessageId ?? null,
        workerId,
      ]);
    } catch (error) {
      const retryable = error instanceof EmailDeliveryError ? error.retryable : true;
      const message = error instanceof Error ? error.message : 'send_failed';
      await notifyWorkerQuery(`select public.fail_notification_delivery($1, $2, $3, $4)`, [
        delivery.id,
        message.slice(0, 800),
        retryable,
        workerId,
      ]);
      logger.error('Notification delivery attempt failed', {
        deliveryId: delivery.id,
        retryable,
      });
    }
  }
}

async function main(): Promise<void> {
  logger.info('Notification delivery worker starting', { workerId, pollMs });
  for (;;) {
    try {
      await tick();
    } catch (error) {
      logger.error('Notification worker tick failed', {
        errorMessage: error instanceof Error ? error.message : 'unknown',
      });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

void main();
