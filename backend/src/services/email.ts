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

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerMessage: string,
  ) {
    super(message);
  }
}

export async function sendInvitationEmail(
  payload: InvitationEmailPayload,
): Promise<{ sent: boolean; skipped?: boolean }> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    logger.info('Invitation email skipped (RESEND_API_KEY not configured)', {
      toDomain: payload.to.split('@')[1] ?? 'unknown',
      businessName: payload.businessName,
    });
    return { sent: false, skipped: true };
  }

  const acceptUrl = `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/invite/accept?token=${encodeURIComponent(payload.acceptToken)}`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [payload.to],
      subject: `You're invited to join ${payload.businessName} on FADEZY OS`,
      html: `
        <p>${payload.inviterLabel} invited you to join <strong>${payload.businessName}</strong> as <strong>${payload.role}</strong>.</p>
        <p><a href="${acceptUrl}">Accept invitation</a></p>
        <p>This link expires in 7 days. If you already have a FADEZY OS account, sign in with this email first, then open the link.</p>
      `,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error('Resend invitation email failed', {
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

    const testingOnly =
      providerMessage.toLowerCase().includes('only send testing emails') ||
      providerMessage.toLowerCase().includes('verify a domain');

    throw new EmailDeliveryError(
      testingOnly
        ? 'Resend is in testing mode: you can only email your Resend account address until you verify a domain. Invitation was still created — resend after verifying a domain, or invite your Resend account email to test.'
        : 'Invitation email could not be delivered. The invitation was still created and can be resent.',
      response.status,
      providerMessage,
    );
  }

  return { sent: true };
}
