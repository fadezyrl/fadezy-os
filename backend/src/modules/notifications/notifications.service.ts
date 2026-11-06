import type { SupabaseClient } from '@supabase/supabase-js';
import {
  API_ERROR_CODES,
  STAFF_PREF_EVENT_TYPES,
  type NotificationListQuery,
  type NotificationPreferenceUpdateInput,
  type PaginatedInAppNotifications,
  type NotificationPreference,
  type InAppNotification,
  type BusinessRole,
} from '@fadezy/shared';
import { mapInAppNotification, mapPreference } from './notifications.mappers';

export class NotificationServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NotificationServiceError';
  }
}

async function getCaller(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<{ role: BusinessRole }> {
  const { data, error } = await client
    .from('business_members')
    .select('role, membership_status, deactivated_at')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new NotificationServiceError(error.message, API_ERROR_CODES.INTERNAL_ERROR, 500);
  }
  if (!data || data.membership_status !== 'active' || data.deactivated_at) {
    throw new NotificationServiceError('Business not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return { role: data.role as BusinessRole };
}

export async function listInAppNotifications(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: NotificationListQuery,
): Promise<PaginatedInAppNotifications> {
  await getCaller(client, businessId, userId);

  let builder = client
    .from('in_app_notifications')
    .select('*', { count: 'exact' })
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);

  if (query.unreadOnly) {
    builder = builder.is('read_at', null);
  }

  const { data, error, count } = await builder;
  if (error) {
    throw new NotificationServiceError(error.message, API_ERROR_CODES.INTERNAL_ERROR, 500);
  }

  const unread = await client
    .from('in_app_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .is('read_at', null);

  return {
    items: (data ?? []).map(mapInAppNotification),
    meta: {
      total: count ?? 0,
      limit: query.limit,
      offset: query.offset,
      unreadCount: unread.count ?? 0,
    },
  };
}

export async function markInAppNotificationRead(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  notificationId: string,
  read: boolean,
): Promise<InAppNotification> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('in_app_notifications')
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq('id', notificationId)
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) {
    throw new NotificationServiceError(error.message, API_ERROR_CODES.INTERNAL_ERROR, 500);
  }
  if (!data) {
    throw new NotificationServiceError('Notification not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return mapInAppNotification(data);
}

export async function listNotificationPreferences(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<NotificationPreference[]> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('notification_preferences')
    .select('*')
    .eq('business_id', businessId)
    .eq('user_id', userId);
  if (error) {
    throw new NotificationServiceError(error.message, API_ERROR_CODES.INTERNAL_ERROR, 500);
  }
  const existing = (data ?? []).map(mapPreference);
  const byKey = new Map(existing.map((p) => [`${p.eventType}:${p.channel}`, p]));

  // Expand defaults for UI: email OFF, in_app ON for staff pref event types
  const defaults: NotificationPreference[] = [];
  for (const eventType of STAFF_PREF_EVENT_TYPES) {
    for (const channel of ['email', 'in_app'] as const) {
      const key = `${eventType}:${channel}`;
      if (byKey.has(key)) {
        defaults.push(byKey.get(key)!);
      } else {
        defaults.push({
          businessId,
          userId,
          eventType,
          channel,
          enabled: channel === 'in_app',
          updatedAt: new Date(0).toISOString(),
        });
      }
    }
  }
  return defaults;
}

export async function updateNotificationPreferences(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: NotificationPreferenceUpdateInput,
): Promise<NotificationPreference[]> {
  await getCaller(client, businessId, userId);
  for (const pref of input.preferences) {
    const { error } = await client.from('notification_preferences').upsert(
      {
        business_id: businessId,
        user_id: userId,
        event_type: pref.eventType,
        channel: pref.channel,
        enabled: pref.enabled,
      },
      { onConflict: 'business_id,user_id,event_type,channel' },
    );
    if (error) {
      throw new NotificationServiceError(error.message, API_ERROR_CODES.INTERNAL_ERROR, 500);
    }
  }
  return listNotificationPreferences(client, businessId, userId);
}
