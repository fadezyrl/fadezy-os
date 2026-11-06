import type { NotificationChannel } from '../constants/notifications';

export type { NotificationChannel };

export interface InAppNotification {
  id: string;
  deliveryId: string;
  businessId: string;
  userId: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreference {
  businessId: string;
  userId: string;
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
  updatedAt: string;
}

export interface PaginatedInAppNotifications {
  items: InAppNotification[];
  meta: { total: number; limit: number; offset: number; unreadCount: number };
}
