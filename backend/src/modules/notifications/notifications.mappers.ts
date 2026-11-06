import type { InAppNotification, NotificationChannel, NotificationPreference } from '@fadezy/shared';

export function mapInAppNotification(row: {
  id: string;
  delivery_id: string;
  business_id: string;
  user_id: string;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
}): InAppNotification {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    businessId: row.business_id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function mapPreference(row: {
  business_id: string;
  user_id: string;
  event_type: string;
  channel: NotificationChannel;
  enabled: boolean;
  updated_at: string;
}): NotificationPreference {
  return {
    businessId: row.business_id,
    userId: row.user_id,
    eventType: row.event_type,
    channel: row.channel,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
}
