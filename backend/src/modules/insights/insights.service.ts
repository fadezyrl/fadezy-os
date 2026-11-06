import type { SupabaseClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import {
  API_ERROR_CODES,
  resolveBookingPermissions,
  resolvePosPermissions,
  resolveSchedulePermissions,
  type BusinessRole,
  type InsightsAgendaItem,
  type InsightsOverviewQuery,
  type WorkspaceInsightsOverview,
} from '@fadezy/shared';
import {
  accumulateBookingStatuses,
  aggregateSalesForSeries,
  enumerateLocalDates,
  periodUtcRange,
  resolvePeriodBounds,
  type BookingAggRow,
  type SaleAggRow,
} from './insights.calc';

export class InsightsServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'InsightsServiceError';
  }
}

function mapError(error: unknown): never {
  if (error instanceof InsightsServiceError) throw error;
  const extended = (error ?? {}) as { message?: string; code?: string };
  const haystack = `${extended.message ?? ''} ${extended.code ?? ''}`.toLowerCase();
  if (haystack.includes('42501') || haystack.includes('forbidden')) {
    throw new InsightsServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  throw new InsightsServiceError(
    extended.message || 'Insights operation failed',
    API_ERROR_CODES.INTERNAL_ERROR,
    500,
  );
}

async function getCaller(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<{ role: BusinessRole; membershipId: string; locationIds: string[] }> {
  const { data, error } = await client
    .from('business_members')
    .select('id, role, membership_status, deactivated_at')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) mapError(error);
  if (!data || data.membership_status !== 'active' || data.deactivated_at) {
    throw new InsightsServiceError(
      'Business not found or not permitted',
      API_ERROR_CODES.NOT_FOUND,
      404,
    );
  }
  const { data: assignments } = await client
    .from('staff_location_assignments')
    .select('location_id')
    .eq('membership_id', data.id);
  return {
    role: data.role as BusinessRole,
    membershipId: data.id,
    locationIds: (assignments ?? []).map((row) => row.location_id),
  };
}

function assertLocationAccess(
  role: BusinessRole,
  assignedLocationIds: string[],
  locationId: string,
): void {
  const bookingPerms = resolveBookingPermissions(role);
  const posPerms = resolvePosPermissions(role);
  if (bookingPerms.canManageAllLocations || posPerms.canManageAllLocations) return;
  if (!assignedLocationIds.includes(locationId)) {
    throw new InsightsServiceError('Not permitted for this location', API_ERROR_CODES.FORBIDDEN, 403);
  }
}

function mapAgenda(
  rows: BookingAggRow[],
  serviceNames: Map<string, string[]>,
): InsightsAgendaItem[] {
  return rows.map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    customerName: row.customer_name,
    serviceSummary: (serviceNames.get(row.id) ?? []).join(', ') || 'Service',
    staffMembershipId: row.staff_membership_id,
  }));
}

export async function getWorkspaceOverview(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: InsightsOverviewQuery,
): Promise<WorkspaceInsightsOverview> {
  const caller = await getCaller(client, businessId, userId);
  assertLocationAccess(caller.role, caller.locationIds, query.locationId);

  const canViewBookings = resolveBookingPermissions(caller.role).canViewBookings;
  const canViewRevenue = resolvePosPermissions(caller.role).canViewReports;
  const canReviewTimeOff = resolveSchedulePermissions(caller.role).canReviewTimeOff;

  const { data: location, error: locError } = await client
    .from('business_locations')
    .select('id, name, timezone, business_id')
    .eq('id', query.locationId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (locError) mapError(locError);
  if (!location?.timezone) {
    throw new InsightsServiceError('Location not found', API_ERROR_CODES.NOT_FOUND, 404);
  }

  const { data: business } = await client
    .from('businesses')
    .select('default_currency')
    .eq('id', businessId)
    .maybeSingle();

  let period;
  try {
    period = resolvePeriodBounds(location.timezone, query.preset, query.from, query.to);
  } catch (error) {
    throw new InsightsServiceError(
      error instanceof Error ? error.message : 'Invalid period',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  const dates = enumerateLocalDates(period.from, period.to, location.timezone);
  const { startIso, endIso } = periodUtcRange(period.from, period.to, location.timezone);
  const todayIso = DateTime.now().setZone(location.timezone).toISODate()!;
  const todayBounds = periodUtcRange(todayIso, todayIso, location.timezone);
  const nowIso = DateTime.now().toUTC().toISO()!;

  let revenueSeries: WorkspaceInsightsOverview['revenueSeries'] = dates.map((date) => ({
    date,
    netCollectedMinor: 0,
    saleCount: 0,
  }));
  let netCollectedMinor: number | null = null;
  let grossSalesMinor: number | null = null;
  let refundedMinor: number | null = null;
  let voidedCount: number | null = null;
  let saleCount: number | null = null;

  if (canViewRevenue) {
    const { data: sales, error: salesError } = await client
      .from('sales')
      .select('created_at, status, subtotal_minor, amount_paid_minor, amount_refunded_minor')
      .eq('business_id', businessId)
      .eq('location_id', query.locationId)
      .gte('created_at', startIso)
      .lt('created_at', endIso);
    if (salesError) mapError(salesError);
    const agg = aggregateSalesForSeries((sales ?? []) as SaleAggRow[], dates, location.timezone);
    revenueSeries = agg.series;
    netCollectedMinor = agg.netCollectedMinor;
    grossSalesMinor = agg.grossSalesMinor;
    refundedMinor = agg.refundedMinor;
    voidedCount = agg.voidedCount;
    saleCount = agg.saleCount;
  }

  let bookingsToday = accumulateBookingStatuses([]);
  let upcomingCount = 0;
  let todayAgenda: InsightsAgendaItem[] = [];
  let upcoming: InsightsAgendaItem[] = [];

  if (canViewBookings) {
    const { data: todayRows, error: todayError } = await client
      .from('bookings')
      .select('id, starts_at, ends_at, status, customer_name, staff_membership_id')
      .eq('business_id', businessId)
      .eq('location_id', query.locationId)
      .gte('starts_at', todayBounds.startIso)
      .lt('starts_at', todayBounds.endIso)
      .order('starts_at', { ascending: true })
      .limit(100);
    if (todayError) mapError(todayError);

    const { data: upcomingRows, error: upcomingError } = await client
      .from('bookings')
      .select('id, starts_at, ends_at, status, customer_name, staff_membership_id')
      .eq('business_id', businessId)
      .eq('location_id', query.locationId)
      .eq('status', 'confirmed')
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(12);
    if (upcomingError) mapError(upcomingError);

    const { count: upcomingExact, error: upcomingCountError } = await client
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('location_id', query.locationId)
      .eq('status', 'confirmed')
      .gte('starts_at', nowIso);
    if (upcomingCountError) mapError(upcomingCountError);

    const typedToday = (todayRows ?? []) as BookingAggRow[];
    const typedUpcoming = (upcomingRows ?? []) as BookingAggRow[];
    bookingsToday = accumulateBookingStatuses(typedToday);
    upcomingCount = upcomingExact ?? typedUpcoming.length;

    const ids = [...new Set([...typedToday, ...typedUpcoming].map((row) => row.id))];
    const serviceNames = new Map<string, string[]>();
    if (ids.length) {
      const { data: services } = await client
        .from('booking_services')
        .select('booking_id, service_name, sort_order')
        .in('booking_id', ids)
        .order('sort_order');
      for (const row of services ?? []) {
        const list = serviceNames.get(row.booking_id) ?? [];
        list.push(row.service_name);
        serviceNames.set(row.booking_id, list);
      }
    }

    todayAgenda = mapAgenda(typedToday.slice(0, 12), serviceNames);
    upcoming = mapAgenda(typedUpcoming, serviceNames);
  }

  const { count: newCustomersCount, error: customerError } = await client
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (customerError) mapError(customerError);

  let pendingTimeOff: WorkspaceInsightsOverview['pendingTimeOff'] = [];
  if (canReviewTimeOff) {
    const { data: timeOff, error: timeOffError } = await client
      .from('staff_time_off')
      .select('id, membership_id, starts_at, ends_at, reason, status')
      .eq('business_id', businessId)
      .eq('status', 'pending')
      .order('starts_at', { ascending: true })
      .limit(10);
    if (timeOffError) mapError(timeOffError);
    pendingTimeOff = (timeOff ?? []).map((row) => ({
      id: row.id,
      membershipId: row.membership_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: row.reason ?? null,
    }));
  }

  return {
    businessId,
    locationId: location.id,
    locationName: location.name,
    timezone: location.timezone,
    currency: business?.default_currency ?? 'USD',
    period,
    generatedAt: new Date().toISOString(),
    canViewRevenue,
    metrics: {
      netCollectedMinor,
      grossSalesMinor,
      refundedMinor,
      voidedCount,
      saleCount,
      bookingsToday,
      upcomingCount,
      newCustomersCount: newCustomersCount ?? 0,
    },
    revenueSeries,
    todayAgenda,
    upcoming,
    pendingTimeOff,
  };
}
