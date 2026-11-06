import { DateTime } from 'luxon';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type InvitationEmailPayload = {
  to: string;
  businessName: string;
  inviterLabel: string;
  role: string;
  /** Raw token — used only to build the accept URL; never logged. */
  acceptToken: string;
};

export type TransactionalEmailPayload = {
  to: string;
  subject: string;
  html: string;
  /** Resend idempotency key mitigation (at-least-once). */
  idempotencyKey?: string;
};

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerMessage: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

async function sendViaResend(
  payload: TransactionalEmailPayload,
): Promise<{ sent: boolean; skipped?: boolean; providerMessageId?: string }> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    logger.info('Transactional email skipped (RESEND_API_KEY not configured)', {
      toDomain: payload.to.split('@')[1] ?? 'unknown',
    });
    return { sent: false, skipped: true };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (payload.idempotencyKey) {
    headers['Idempotency-Key'] = payload.idempotencyKey;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error('Resend email failed', {
      status: response.status,
      body: body.slice(0, 300),
      toDomain: payload.to.split('@')[1] ?? 'unknown',
    });

    let providerMessage = 'Email provider rejected the send.';
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) providerMessage = parsed.message;
    } catch {
      // keep default
    }

    const permanent =
      response.status === 400 ||
      response.status === 422 ||
      providerMessage.toLowerCase().includes('invalid') ||
      providerMessage.toLowerCase().includes('only send testing emails') ||
      providerMessage.toLowerCase().includes('verify a domain');

    throw new EmailDeliveryError(
      permanent
        ? providerMessage
        : 'Email could not be delivered.',
      response.status,
      providerMessage,
      !permanent,
    );
  }

  const json = (await response.json().catch(() => ({}))) as { id?: string };
  return { sent: true, providerMessageId: json.id };
}

export async function sendInvitationEmail(
  payload: InvitationEmailPayload,
): Promise<{ sent: boolean; skipped?: boolean }> {
  const acceptUrl = `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/invite/accept?token=${encodeURIComponent(payload.acceptToken)}`;
  try {
    const result = await sendViaResend({
      to: payload.to,
      subject: `You're invited to join ${payload.businessName} on FADEZY OS`,
      html: `
        <p>${payload.inviterLabel} invited you to join <strong>${payload.businessName}</strong> as <strong>${payload.role}</strong>.</p>
        <p><a href="${acceptUrl}">Accept invitation</a></p>
        <p>This link expires in 7 days. If you already have a FADEZY OS account, sign in with this email first, then open the link.</p>
      `,
    });
    return { sent: result.sent, skipped: result.skipped };
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      const testingOnly =
        error.providerMessage.toLowerCase().includes('only send testing emails') ||
        error.providerMessage.toLowerCase().includes('verify a domain');
      throw new EmailDeliveryError(
        testingOnly
          ? 'Resend is in testing mode: you can only email your Resend account address until you verify a domain. Invitation was still created — resend after verifying a domain, or invite your Resend account email to test.'
          : 'Invitation email could not be delivered. The invitation was still created and can be resent.',
        error.status,
        error.providerMessage,
        error.retryable,
      );
    }
    throw error;
  }
}

export async function sendTransactionalEmail(
  payload: TransactionalEmailPayload,
): Promise<{ sent: boolean; skipped?: boolean; providerMessageId?: string }> {
  return sendViaResend(payload);
}

function formatWhen(startsAt: string | undefined, timezone: string | undefined): string {
  if (!startsAt) return '';
  const zone = timezone || 'UTC';
  const dt = DateTime.fromISO(startsAt, { zone: 'utc' }).setZone(zone);
  if (!dt.isValid) return startsAt;
  return dt.toFormat("ccc d LLL yyyy, HH:mm ZZZZ");
}

export function renderBookingCustomerEmail(
  templateKey: string,
  payload: Record<string, unknown>,
): { subject: string; html: string } {
  const businessName = String(payload.businessName ?? 'FADEZY');
  const when = formatWhen(
    payload.startsAt ? String(payload.startsAt) : undefined,
    payload.timezone ? String(payload.timezone) : undefined,
  );
  const location = String(payload.locationName ?? '');
  const staff = String(payload.staffDisplayName ?? '');
  const ref = String(payload.referenceCode ?? '');

  const subjects: Record<string, string> = {
    booking_created_customer: `Booking confirmed — ${businessName}`,
    booking_rescheduled_customer: `Booking rescheduled — ${businessName}`,
    booking_cancelled_customer: `Booking cancelled — ${businessName}`,
    booking_reminder_customer: `Reminder: appointment in 24 hours — ${businessName}`,
  };

  const intros: Record<string, string> = {
    booking_created_customer: 'Your booking is confirmed.',
    booking_rescheduled_customer: 'Your booking was rescheduled.',
    booking_cancelled_customer: 'Your booking was cancelled.',
    booking_reminder_customer: 'This is a reminder for your upcoming appointment.',
  };

  return {
    subject: subjects[templateKey] ?? `Update from ${businessName}`,
    html: `
      <p>${intros[templateKey] ?? 'Booking update.'}</p>
      <p><strong>${when}</strong></p>
      <p>${location}${staff ? ` · ${staff}` : ''}</p>
      ${ref ? `<p>Reference: ${ref}</p>` : ''}
      <p>${businessName}</p>
    `,
  };
}

export function renderGenericStaffEmail(
  templateKey: string,
  payload: Record<string, unknown>,
): { subject: string; html: string } {
  const businessName = String(payload.businessName ?? 'FADEZY');
  const title = String(payload.title ?? templateKey);
  const body = String(payload.body ?? '');
  return {
    subject: `${title} — ${businessName}`,
    html: `<p>${body}</p><p>${businessName}</p>`,
  };
}
