import { z } from 'zod';
import { NOTIFICATION_CHANNELS, STAFF_PREF_EVENT_TYPES } from '../constants/notifications';

export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const markNotificationReadSchema = z.object({
  read: z.boolean().optional().default(true),
});

export const notificationPreferenceUpdateSchema = z.object({
  preferences: z
    .array(
      z.object({
        eventType: z.enum(STAFF_PREF_EVENT_TYPES),
        channel: z.enum(NOTIFICATION_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
});

export type NotificationListQuery = z.output<typeof notificationListQuerySchema>;
export type MarkNotificationReadInput = z.input<typeof markNotificationReadSchema>;
export type NotificationPreferenceUpdateInput = z.input<typeof notificationPreferenceUpdateSchema>;
