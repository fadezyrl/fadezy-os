import type { SupabaseClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import type {
  AvailabilityContext,
  AvailabilityContextQuery,
  BusinessOperatingHours,
  BusinessRole,
  CreateTimeOffInput,
  LocationOperatingHours,
  PutLocationHoursInput,
  PutStaffScheduleInput,
  PutWeeklyHoursInput,
  ScheduleDateException,
  ScheduleExceptionInput,
  SchedulePermissions,
  StaffTimeOff,
  StaffWeeklySchedule,
} from '@fadezy/shared';
import { resolveSchedulePermissions } from '@fadezy/shared';
import { buildAvailabilityContext, weekdayInZone, type MinuteInterval } from './availability';
import {
  mapException,
  mapHoursMode,
  mapStaffBreak,
  mapStaffInterval,
  mapStaffSchedule,
  mapTimeOff,
  mapWeeklyInterval,
} from './schedule.mappers';

export class ScheduleServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function mapDbError(error: { message?: string; code?: string } | null): never {
  const message = error?.message ?? 'Database operation failed';
  const lower = message.toLowerCase();
  if (lower.includes('overlapping_intervals')) {
    throw new ScheduleServiceError('Overlapping intervals are not allowed', 'VALIDATION_ERROR', 422);
  }
  if (lower.includes('break_outside_interval')) {
    throw new ScheduleServiceError('Break must fall within a working interval', 'VALIDATION_ERROR', 422);
  }
  if (lower.includes('location_not_assigned')) {
    throw new ScheduleServiceError('Staff is not assigned to that location', 'VALIDATION_ERROR', 422);
  }
  if (lower.includes('location_required')) {
    throw new ScheduleServiceError('Location is required on staff schedule intervals', 'VALIDATION_ERROR', 422);
  }
  if (lower.includes('cannot_review_own_time_off')) {
    throw new ScheduleServiceError('You cannot approve or reject your own time-off request', 'FORBIDDEN', 403);
  }
  if (lower.includes('forbidden') || error?.code === '42501' || lower.includes('row-level security')) {
    throw new ScheduleServiceError('Not permitted for this business schedule', 'FORBIDDEN', 403);
  }
  if (lower.includes('not_found') || error?.code === 'P0002') {
    throw new ScheduleServiceError('Resource not found', 'NOT_FOUND', 404);
  }
  throw new ScheduleServiceError('Unable to complete schedule operation', 'INTERNAL_ERROR', 500);
}

async function getCaller(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<{ role: BusinessRole; membershipId: string }> {
  const { data, error } = await client
    .from('business_members')
    .select('id, role, membership_status, deactivated_at')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) mapDbError(error);
  if (!data || data.membership_status !== 'active' || data.deactivated_at) {
    throw new ScheduleServiceError('Business not found or not permitted', 'NOT_FOUND', 404);
  }
  return { role: data.role as BusinessRole, membershipId: data.id };
}

export async function getSchedulePermissions(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<SchedulePermissions> {
  const caller = await getCaller(client, businessId, userId);
  return resolveSchedulePermissions(caller.role);
}

export async function getBusinessHours(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<BusinessOperatingHours> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('business_weekly_hours')
    .select('*')
    .eq('business_id', businessId)
    .order('weekday')
    .order('sort_order')
    .order('start_minute');
  if (error) mapDbError(error);
  return {
    businessId,
    intervals: (data ?? []).map(mapWeeklyInterval),
    updatedAt: data?.[0]?.updated_at ?? null,
  };
}

export async function putBusinessHours(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: PutWeeklyHoursInput,
): Promise<BusinessOperatingHours> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canManageHours) {
    throw new ScheduleServiceError('Not permitted to manage operating hours', 'FORBIDDEN', 403);
  }
  const { error } = await client.rpc('replace_business_weekly_hours', {
    p_business_id: businessId,
    p_intervals: (input.intervals ?? []).map((item) => ({
      weekday: item.weekday,
      start_minute: item.startMinute,
      end_minute: item.endMinute,
      sort_order: item.sortOrder ?? 0,
    })),
  });
  if (error) mapDbError(error);
  return getBusinessHours(client, businessId, userId);
}

export async function getLocationHours(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  locationId: string,
): Promise<LocationOperatingHours> {
  await getCaller(client, businessId, userId);
  const { data: location, error: locError } = await client
    .from('business_locations')
    .select('id, business_id, timezone, hours_mode, updated_at')
    .eq('id', locationId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (locError) mapDbError(locError);
  if (!location) throw new ScheduleServiceError('Location not found', 'NOT_FOUND', 404);

  const mode = mapHoursMode(location.hours_mode);
  if (mode === 'inherit') {
    const businessHours = await getBusinessHours(client, businessId, userId);
    return {
      businessId,
      locationId,
      hoursMode: mode,
      intervals: businessHours.intervals,
      source: 'business',
      timezone: location.timezone,
      updatedAt: location.updated_at,
    };
  }

  const { data, error } = await client
    .from('location_weekly_hours')
    .select('*')
    .eq('location_id', locationId)
    .order('weekday')
    .order('sort_order')
    .order('start_minute');
  if (error) mapDbError(error);
  return {
    businessId,
    locationId,
    hoursMode: mode,
    intervals: (data ?? []).map(mapWeeklyInterval),
    source: 'location',
    timezone: location.timezone,
    updatedAt: data?.[0]?.updated_at ?? location.updated_at,
  };
}

export async function putLocationHours(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  locationId: string,
  input: PutLocationHoursInput,
): Promise<LocationOperatingHours> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canManageHours) {
    throw new ScheduleServiceError('Not permitted to manage operating hours', 'FORBIDDEN', 403);
  }
  const { error } = await client.rpc('replace_location_weekly_hours', {
    p_location_id: locationId,
    p_hours_mode: input.hoursMode,
    p_intervals: (input.intervals ?? []).map((item) => ({
      weekday: item.weekday,
      start_minute: item.startMinute,
      end_minute: item.endMinute,
      sort_order: item.sortOrder ?? 0,
    })),
  });
  if (error) mapDbError(error);
  return getLocationHours(client, businessId, userId, locationId);
}

export async function listExceptions(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  locationId?: string,
): Promise<ScheduleDateException[]> {
  await getCaller(client, businessId, userId);
  let query = client
    .from('schedule_date_exceptions')
    .select('*')
    .eq('business_id', businessId)
    .is('cancelled_at', null)
    .order('exception_date', { ascending: true });
  if (locationId) {
    query = query.or(`location_id.eq.${locationId},location_id.is.null`);
  }
  const { data, error } = await query;
  if (error) mapDbError(error);
  return (data ?? []).map(mapException);
}

export async function createException(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: ScheduleExceptionInput,
): Promise<ScheduleDateException> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canManageHours) {
    throw new ScheduleServiceError('Not permitted to manage exceptions', 'FORBIDDEN', 403);
  }
  const { data, error } = await client.rpc('create_schedule_date_exception', {
    payload: {
      business_id: businessId,
      location_id: input.locationId ?? null,
      exception_date: input.exceptionDate,
      kind: input.kind,
      label: input.label ?? null,
      intervals: (input.intervals ?? []).map((item) => ({
        start_minute: item.startMinute,
        end_minute: item.endMinute,
      })),
    },
  });
  if (error) mapDbError(error);
  return mapException(data);
}

export async function cancelException(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  exceptionId: string,
): Promise<ScheduleDateException> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canManageHours) {
    throw new ScheduleServiceError('Not permitted to manage exceptions', 'FORBIDDEN', 403);
  }
  const { data, error } = await client.rpc('cancel_schedule_date_exception', {
    p_exception_id: exceptionId,
  });
  if (error) mapDbError(error);
  const mapped = mapException(data);
  if (mapped.businessId !== businessId) {
    throw new ScheduleServiceError('Exception not found', 'NOT_FOUND', 404);
  }
  return mapped;
}

async function loadScheduleDetails(
  client: SupabaseClient,
  scheduleRows: Array<Record<string, unknown>>,
): Promise<StaffWeeklySchedule[]> {
  if (!scheduleRows.length) return [];
  const ids = scheduleRows.map((row) => String(row.id));
  const [{ data: intervals }, { data: breaks }] = await Promise.all([
    client.from('staff_weekly_intervals').select('*').in('schedule_id', ids),
    client.from('staff_weekly_breaks').select('*').in('schedule_id', ids),
  ]);
  return scheduleRows.map((row) =>
    mapStaffSchedule(
      row as Parameters<typeof mapStaffSchedule>[0],
      (intervals ?? [])
        .filter((item) => item.schedule_id === row.id)
        .map(mapStaffInterval),
      (breaks ?? []).filter((item) => item.schedule_id === row.id).map(mapStaffBreak),
    ),
  );
}

export async function listStaffSchedules(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
): Promise<StaffWeeklySchedule[]> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolveSchedulePermissions(caller.role);
  if (!permissions.canViewAllSchedules && caller.membershipId !== membershipId) {
    throw new ScheduleServiceError('Not permitted to view this schedule', 'FORBIDDEN', 403);
  }
  const { data, error } = await client
    .from('staff_weekly_schedules')
    .select('*')
    .eq('business_id', businessId)
    .eq('membership_id', membershipId)
    .order('effective_from', { ascending: false });
  if (error) mapDbError(error);
  return loadScheduleDetails(client, data ?? []);
}

export async function putStaffSchedule(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  membershipId: string,
  input: PutStaffScheduleInput,
): Promise<StaffWeeklySchedule> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canManageStaffSchedules) {
    throw new ScheduleServiceError('Not permitted to manage staff schedules', 'FORBIDDEN', 403);
  }

  const { data: assignments } = await client
    .from('staff_location_assignments')
    .select('location_id')
    .eq('membership_id', membershipId);
  const assigned = new Set((assignments ?? []).map((row) => row.location_id));
  if (assigned.size > 1) {
    for (const interval of input.intervals ?? []) {
      if (!interval.locationId || !assigned.has(interval.locationId)) {
        throw new ScheduleServiceError(
          'Each interval requires an assigned location when staff has multiple locations',
          'VALIDATION_ERROR',
          422,
        );
      }
    }
  }

  const { data, error } = await client.rpc('replace_staff_weekly_schedule', {
    payload: {
      business_id: businessId,
      membership_id: membershipId,
      effective_from: input.effectiveFrom,
      label: input.label ?? null,
      intervals: (input.intervals ?? []).map((item) => ({
        weekday: item.weekday,
        location_id: item.locationId,
        start_minute: item.startMinute,
        end_minute: item.endMinute,
        sort_order: item.sortOrder ?? 0,
      })),
      breaks: (input.breaks ?? []).map((item) => ({
        weekday: item.weekday,
        start_minute: item.startMinute,
        end_minute: item.endMinute,
        is_paid: item.isPaid ?? false,
        sort_order: item.sortOrder ?? 0,
      })),
    },
  });
  if (error) mapDbError(error);
  const list = await loadScheduleDetails(client, [data]);
  return list[0];
}

export async function listTimeOff(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<StaffTimeOff[]> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolveSchedulePermissions(caller.role);
  let query = client
    .from('staff_time_off')
    .select('*')
    .eq('business_id', businessId)
    .order('starts_at', { ascending: false });
  if (!permissions.canViewAllSchedules) {
    query = query.eq('membership_id', caller.membershipId);
  }
  const { data, error } = await query;
  if (error) mapDbError(error);
  return (data ?? []).map(mapTimeOff);
}

export async function createTimeOff(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CreateTimeOffInput,
): Promise<StaffTimeOff> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canRequestTimeOff) {
    throw new ScheduleServiceError('Not permitted to request time off', 'FORBIDDEN', 403);
  }

  const targetMembershipId = input.membershipId ?? caller.membershipId;
  if (
    targetMembershipId !== caller.membershipId &&
    !resolveSchedulePermissions(caller.role).canReviewTimeOff
  ) {
    throw new ScheduleServiceError('Not permitted to request time off for another member', 'FORBIDDEN', 403);
  }

  let timezone = input.timezone;
  if (!timezone) {
    const { data: business } = await client
      .from('businesses')
      .select('timezone')
      .eq('id', businessId)
      .maybeSingle();
    timezone = business?.timezone;
  }
  if (input.locationId) {
    const { data: location } = await client
      .from('business_locations')
      .select('timezone, business_id')
      .eq('id', input.locationId)
      .maybeSingle();
    if (!location || location.business_id !== businessId) {
      throw new ScheduleServiceError('Location not found', 'NOT_FOUND', 404);
    }
    timezone = location.timezone;
  }
  if (!timezone) {
    throw new ScheduleServiceError('Timezone is required', 'VALIDATION_ERROR', 422);
  }

  const isFullDay = input.isFullDay !== false;
  const startMinute = isFullDay ? 0 : (input.startMinute ?? 0);
  const endMinute = isFullDay ? 1440 : (input.endMinute ?? 1440);
  if (DateTime.fromISO(input.endDate) < DateTime.fromISO(input.startDate)) {
    throw new ScheduleServiceError('endDate must be on or after startDate', 'VALIDATION_ERROR', 422);
  }

  const startsAt = DateTime.fromISO(input.startDate, { zone: timezone })
    .startOf('day')
    .plus({ minutes: startMinute })
    .toUTC()
    .toISO();
  const endsAt = DateTime.fromISO(input.endDate, { zone: timezone })
    .startOf('day')
    .plus({ minutes: endMinute })
    .toUTC()
    .toISO();
  if (!startsAt || !endsAt) {
    throw new ScheduleServiceError('Invalid time-off range for timezone', 'VALIDATION_ERROR', 422);
  }

  const { data, error } = await client
    .from('staff_time_off')
    .insert({
      business_id: businessId,
      membership_id: targetMembershipId,
      location_id: input.locationId ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      timezone,
      is_full_day: isFullDay,
      category: input.category,
      reason: input.reason ?? null,
      status: 'pending',
      requested_by: userId,
    })
    .select('*')
    .single();
  if (error) mapDbError(error);
  return mapTimeOff(data);
}

export async function reviewTimeOff(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  timeOffId: string,
  action: 'approve' | 'reject',
): Promise<StaffTimeOff> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolveSchedulePermissions(caller.role).canReviewTimeOff) {
    throw new ScheduleServiceError('Not permitted to review time off', 'FORBIDDEN', 403);
  }
  const { data, error } = await client.rpc('review_staff_time_off', {
    p_time_off_id: timeOffId,
    p_action: action,
  });
  if (error) mapDbError(error);
  const mapped = mapTimeOff(data);
  if (mapped.businessId !== businessId) {
    throw new ScheduleServiceError('Time off not found', 'NOT_FOUND', 404);
  }
  return mapped;
}

export async function cancelTimeOff(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  timeOffId: string,
): Promise<StaffTimeOff> {
  const caller = await getCaller(client, businessId, userId);
  const { data: existing, error: findError } = await client
    .from('staff_time_off')
    .select('*')
    .eq('id', timeOffId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (findError) mapDbError(findError);
  if (!existing) throw new ScheduleServiceError('Time off not found', 'NOT_FOUND', 404);

  const permissions = resolveSchedulePermissions(caller.role);
  const isSelf = existing.membership_id === caller.membershipId;
  if (!permissions.canReviewTimeOff && !isSelf) {
    throw new ScheduleServiceError('Not permitted to cancel this request', 'FORBIDDEN', 403);
  }
  if (existing.status !== 'pending' && !permissions.canReviewTimeOff) {
    throw new ScheduleServiceError('Only pending requests can be cancelled by staff', 'CONFLICT', 409);
  }

  const { data, error } = await client
    .from('staff_time_off')
    .update({ status: 'cancelled' })
    .eq('id', timeOffId)
    .select('*')
    .single();
  if (error) mapDbError(error);
  return mapTimeOff(data);
}

export async function getAvailabilityContext(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: AvailabilityContextQuery,
): Promise<AvailabilityContext> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolveSchedulePermissions(caller.role);
  const membershipId = query.membershipId ?? null;

  if (
    membershipId &&
    !permissions.canViewAllSchedules &&
    membershipId !== caller.membershipId
  ) {
    throw new ScheduleServiceError('Not permitted to view this availability', 'FORBIDDEN', 403);
  }

  const locationHours = await getLocationHours(client, businessId, userId, query.locationId);
  const weekday = weekdayInZone(query.date, locationHours.timezone);
  const notes: string[] = [];

  const { data: exceptions } = await client
    .from('schedule_date_exceptions')
    .select('*')
    .eq('business_id', businessId)
    .is('cancelled_at', null)
    .eq('exception_date', query.date);

  const locationException =
    (exceptions ?? []).find((item) => item.location_id === query.locationId) ??
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
    locationWindows = (locationException.intervals as Array<{ start_minute: number; end_minute: number }>).map(
      (item) => ({ startMinute: item.start_minute, endMinute: item.end_minute }),
    );
    notes.push('Location using special hours exception');
  } else {
    locationWindows = locationHours.intervals
      .filter((item) => item.weekday === weekday)
      .map((item) => ({ startMinute: item.startMinute, endMinute: item.endMinute }));
    locationSource = locationHours.source === 'business' ? 'inherit_weekly' : 'weekly';
    if (!locationWindows.length) {
      locationClosed = true;
      notes.push('No weekly open intervals for this weekday');
    }
  }

  let staffWindows: MinuteInterval[] = [];
  let staffBreaks: MinuteInterval[] = [];
  const timeOffBlocks: AvailabilityContext['timeOffBlocks'] = [];

  if (membershipId) {
    const schedules = await listStaffSchedules(client, businessId, userId, membershipId);
    const active = schedules.find((schedule) => {
      const fromOk = schedule.effectiveFrom <= query.date;
      const toOk = !schedule.effectiveTo || schedule.effectiveTo >= query.date;
      return fromOk && toOk;
    });

    if (active) {
      staffWindows = active.intervals
        .filter((item) => item.weekday === weekday && item.locationId === query.locationId)
        .map((item) => ({ startMinute: item.startMinute, endMinute: item.endMinute }));
      staffBreaks = active.breaks
        .filter((item) => item.weekday === weekday)
        .map((item) => ({ startMinute: item.startMinute, endMinute: item.endMinute }));
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
      if (row.location_id && row.location_id !== query.locationId) continue;
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
    locationId: query.locationId,
    membershipId,
    date: query.date,
    timezone: locationHours.timezone,
    locationClosed,
    locationWindows,
    locationSource,
    staffWindows,
    staffBreaks,
    timeOffBlocks,
    notes,
  });
}
