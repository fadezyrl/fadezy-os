/**
 * Lightweight verification for insights calculation helpers.
 * Run: npx tsx src/modules/insights/insights.calc.selfcheck.ts
 */
import { DateTime } from 'luxon';
import {
  accumulateBookingStatuses,
  aggregateSalesForSeries,
  enumerateLocalDates,
  periodUtcRange,
  resolvePeriodBounds,
} from './insights.calc';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(): void {
  const tz = 'America/New_York';
  const period = resolvePeriodBounds(tz, '7d');
  assert(period.days === 7, `expected 7 days, got ${period.days}`);
  assert(period.to === DateTime.now().setZone(tz).toISODate(), 'period.to should be local today');

  const dates = enumerateLocalDates(period.from, period.to, tz);
  assert(dates.length === 7, `expected 7 date buckets, got ${dates.length}`);

  const { startIso, endIso } = periodUtcRange(period.from, period.to, tz);
  assert(startIso < endIso, 'UTC range should be ordered');

  // Sale created near midnight UTC still buckets by location-local day.
  const localNoon = DateTime.fromISO(period.to, { zone: tz }).set({
    hour: 12,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const sales = [
    {
      created_at: localNoon.toUTC().toISO()!,
      status: 'paid',
      subtotal_minor: 10000,
      amount_paid_minor: 10000,
      amount_refunded_minor: 2500,
    },
    {
      created_at: localNoon.toUTC().toISO()!,
      status: 'voided',
      subtotal_minor: 5000,
      amount_paid_minor: 0,
      amount_refunded_minor: 0,
    },
  ];
  const agg = aggregateSalesForSeries(sales, dates, tz);
  assert(agg.netCollectedMinor === 7500, `net collected expected 7500, got ${agg.netCollectedMinor}`);
  assert(agg.grossSalesMinor === 10000, `gross expected 10000, got ${agg.grossSalesMinor}`);
  assert(agg.refundedMinor === 2500, `refunded expected 2500, got ${agg.refundedMinor}`);
  assert(agg.voidedCount === 1, `voided expected 1, got ${agg.voidedCount}`);
  assert(agg.saleCount === 1, `saleCount expected 1 (void excluded), got ${agg.saleCount}`);

  const statuses = accumulateBookingStatuses([
    { status: 'confirmed' },
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'no_show' },
    { status: 'confirmed' },
  ]);
  assert(statuses.confirmed === 2, 'confirmed count');
  assert(statuses.completed === 1, 'completed count');
  assert(statuses.cancelled === 1, 'cancelled count');
  assert(statuses.no_show === 1, 'no_show count');
  assert(statuses.total === 5, 'total count');

  // Custom bounds clamp length
  const custom = resolvePeriodBounds(tz, '30d', period.from, period.to);
  assert(custom.days === 7, 'custom from/to should honor inclusive span');

  console.log('insights.calc.selfcheck: ok');
}

run();
