export const NOTIFICATION_CHANNELS = ['email', 'in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Optional staff operational prefs exposed in UI (email default OFF). */
export const STAFF_PREF_EVENT_TYPES = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.completed',
  'booking.no_show',
  'time_off.requested',
  'sale.created',
  'sale.payment_recorded',
  'sale.refund_recorded',
  'sale.voided',
] as const;

export type StaffPrefEventType = (typeof STAFF_PREF_EVENT_TYPES)[number];
