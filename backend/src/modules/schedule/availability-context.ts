import type { SupabaseClient } from '@supabase/supabase-js';
import type { AvailabilityContext } from '@fadezy/shared';
import { buildAvailabilityContext, weekdayInZone, type MinuteInterval } from './availability';
import { mapWeeklyInterval } from './schedule.mappers';

/**
 * Internal availability context builder used by Phase 06 API and Phase 07 slot engine.
 * Does not enforce caller permissions — callers must authorize first.
 */
export async function resolveAvailabilityContextInternal(
  client: SupabaseClient,
  input: {
    businessId: string;
    locationId: string;
    membershipId: string | null;
    date: string;
  },
): Promise<AvailabilityContext> {
  const { businessId, locationId, membershipId, date } = input;

  const { data: location, error: locError } = await client
    .from('business_locations')
    .select('id, business_id, timezone, hours_mode')
    .eq('id', locationId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (locError) throw locError;
  if (!location) {
    throw new Error('LOCATION_NOT_FOUND');
  }

  const hoursMode = location.hours_mode === 'custom' ? 'custom' : 'inherit';
  let intervals: ReturnType<typeof mapWeeklyInterval>[] = [];

  if (hoursMode === 'inherit') {
    const { data } = await client
      .from('business_weekly_hours')
      .select('*')
      .eq('business_id', businessId)
      .order('weekday')
      .order('sort_order')
      .order('start_minute');
    intervals = (data ?? []).map(mapWeeklyInterval);
  } else {
    const { data } = await client
      .from('location_weekly_hours')
      .select('*')
      .eq('location_id', locationId)
      .order('weekday')
      .order('sort_order')
      .order('start_minute');
    intervals = (data ?? []).map(mapWeeklyInterval);
  }

  const weekday = weekdayInZone(date, location.timezone);
  const notes: string[] = [];

  const { data: exceptions } = await client
    .from('schedule_date_exceptions')
    .select('*')
    .eq('business_id', businessId)
    .is('cancelled_at', null)
    .eq('exception_date', date);

  const locationException =
    (exceptions ?? []).find((item) => item.location_id === locationId) ??
    (exceptions ?? []).find((item) => item.location_id == null) ??
    null;

  let locationClosed = false;
  let locationWindows: MinuteInterval[] = [];
  let locationSource: AvailabilityContext['locationSource'] = 'none';

  if (locationException?.kind === 'closed') {
    locationClosed = true;
    locationSource = 'closed_exception';
    notes.push('Location closed by dated exception');
  } else if (locationException?.kind === 'special_hours') {
    locationSource = 'special_hours';
    locationWindows = (
      locationException.intervals as Array<{ start_minute: number; end_minute: number }>
    ).map((item) => ({ startMinute: item.start_minute, endMinute: item.end_minute }));
    notes.push('Location using special hours exception');
  } else {
    locationWindows = intervals
      .filter((item) => item.weekday === weekday)
      .map((item) => ({ startMinute: item.startMinute, endMinute: item.endMinute }));
    locationSource = hoursMode === 'inherit' ? 'inherit_weekly' : 'weekly';
    if (!locationWindows.length) {
      locationClosed = true;
      notes.push('No weekly open intervals for this weekday');
    }
  }

  let staffWindows: MinuteInterval[] = [];
  let staffBreaks: MinuteInterval[] = [];
  const timeOffBlocks: AvailabilityContext['timeOffBlocks'] = [];

  if (membershipId) {
    const { data: schedules } = await client
      .from('staff_weekly_schedules')
      .select('*')
      .eq('business_id', businessId)
      .eq('membership_id', membershipId)
      .order('effective_from', { ascending: false });

    const active = (schedules ?? []).find((schedule) => {
      const fromOk = schedule.effective_from <= date;
      const toOk = !schedule.effective_to || schedule.effective_to >= date;
      return fromOk && toOk;
    });

    if (active) {
      const [{ data: intervalRows }, { data: breakRows }] = await Promise.all([
        client.from('staff_weekly_intervals').select('*').eq('schedule_id', active.id),
        client.from('staff_weekly_breaks').select('*').eq('schedule_id', active.id),
      ]);
      staffWindows = (intervalRows ?? [])
        .filter((item) => item.weekday === weekday && item.location_id === locationId)
        .map((item) => ({ startMinute: item.start_minute, endMinute: item.end_minute }));
      staffBreaks = (breakRows ?? [])
        .filter((item) => item.weekday === weekday)
        .map((item) => ({ startMinute: item.start_minute, endMinute: item.end_minute }));
    } else {
      notes.push('No effective staff schedule version for date');
    }

    const { data: timeOffRows } = await client
      .from('staff_time_off')
      .select('*')
      .eq('business_id', businessId)
      .eq('membership_id', membershipId)
      .in('status', ['approved', 'pending']);

    for (const row of timeOffRows ?? []) {
      if (row.location_id && row.location_id !== locationId) continue;
      timeOffBlocks.push({
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
      });
    }
    if (timeOffBlocks.some((item) => item.status === 'approved')) {
      notes.push('Approved time off applied over recurring schedule');
    }
  }

  if (locationClosed) {
    notes.push('Location closure overrides staff availability');
  }

  return buildAvailabilityContext({
    businessId,
    locationId,
    membershipId,
    date,
    timezone: location.timezone,
    locationClosed,
    locationWindows,
    locationSource,
    staffWindows,
    staffBreaks,
    timeOffBlocks,
    notes,
  });
}
