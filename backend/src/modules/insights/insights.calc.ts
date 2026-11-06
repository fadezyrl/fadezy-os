import { DateTime } from 'luxon';
import type { BookingStatus, InsightsBookingStatusCounts, InsightsRevenuePoint } from '@fadezy/shared';
import { localDayUtcBounds } from '../schedule/availability';

export type SaleAggRow = {
  created_at: string;
  status: string;
  subtotal_minor: number | string;
  amount_paid_minor: number | string;
  amount_refunded_minor: number | string;
};

export type BookingAggRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  customer_name: string;
  staff_membership_id: string;
};

/** Inclusive local date list from `from` through `to` in a timezone. */
export function enumerateLocalDates(from: string, to: string, timeZone: string): string[] {
  let cursor = DateTime.fromISO(from, { zone: timeZone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timeZone }).startOf('day');
  if (!cursor.isValid || !end.isValid || end < cursor) return [];
  const dates: string[] = [];
  while (cursor <= end) {
    dates.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export function resolvePeriodBounds(
  timeZone: string,
  preset: '7d' | '30d',
  from?: string,
  to?: string,
): { from: string; to: string; days: number; preset: '7d' | '30d' } {
  const today = DateTime.now().setZone(timeZone).startOf('day');
  if (!today.isValid) {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
  const end = to ? DateTime.fromISO(to, { zone: timeZone }).startOf('day') : today;
  const startDefault = today.minus({ days: preset === '7d' ? 6 : 29 });
  const start = from ? DateTime.fromISO(from, { zone: timeZone }).startOf('day') : startDefault;
  if (!start.isValid || !end.isValid) {
    throw new Error('Invalid from/to date');
  }
  if (end < start) {
    throw new Error('Period end must be on or after start');
  }
  const days = Math.floor(end.diff(start, 'days').days) + 1;
  if (days > 93) {
    throw new Error('Period cannot exceed 93 days');
  }
  return {
    from: start.toISODate()!,
    to: end.toISODate()!,
    days,
    preset,
  };
}

export function periodUtcRange(
  from: string,
  to: string,
  timeZone: string,
): { startIso: string; endIso: string } {
  const start = localDayUtcBounds(from, timeZone).startUtc.toISO();
  const endExclusive = localDayUtcBounds(to, timeZone).endUtc.toISO();
  if (!start || !endExclusive) throw new Error('Unable to resolve period UTC range');
  return { startIso: start, endIso: endExclusive };
}

export function emptyStatusCounts(): InsightsBookingStatusCounts {
  return { confirmed: 0, completed: 0, cancelled: 0, no_show: 0, total: 0 };
}

export function accumulateBookingStatuses(
  rows: Array<{ status: string }>,
): InsightsBookingStatusCounts {
  const counts = emptyStatusCounts();
  for (const row of rows) {
    const status = row.status as BookingStatus;
    if (status === 'confirmed' || status === 'completed' || status === 'cancelled' || status === 'no_show') {
      counts[status] += 1;
    }
    counts.total += 1;
  }
  return counts;
}

/**
 * Net collected = paid − refunded for non-voided sales (same as POS daily summary).
 */
export function aggregateSalesForSeries(
  rows: SaleAggRow[],
  dates: string[],
  timeZone: string,
): {
  series: InsightsRevenuePoint[];
  netCollectedMinor: number;
  grossSalesMinor: number;
  refundedMinor: number;
  voidedCount: number;
  saleCount: number;
} {
  const byDate = new Map<string, InsightsRevenuePoint>();
  for (const date of dates) {
    byDate.set(date, { date, netCollectedMinor: 0, saleCount: 0 });
  }

  let netCollectedMinor = 0;
  let grossSalesMinor = 0;
  let refundedMinor = 0;
  let voidedCount = 0;
  let saleCount = 0;

  for (const row of rows) {
    const localDate = DateTime.fromISO(row.created_at, { zone: 'utc' }).setZone(timeZone).toISODate();
    if (!localDate || !byDate.has(localDate)) continue;

    if (row.status === 'voided') {
      voidedCount += 1;
      continue;
    }

    const paid = Number(row.amount_paid_minor);
    const refunded = Number(row.amount_refunded_minor);
    const net = paid - refunded;
    const gross = Number(row.subtotal_minor);

    saleCount += 1;
    netCollectedMinor += net;
    grossSalesMinor += gross;
    refundedMinor += refunded;

    const point = byDate.get(localDate)!;
    point.netCollectedMinor += net;
    point.saleCount += 1;
  }

  return {
    series: dates.map((date) => byDate.get(date)!),
    netCollectedMinor,
    grossSalesMinor,
    refundedMinor,
    voidedCount,
    saleCount,
  };
}
