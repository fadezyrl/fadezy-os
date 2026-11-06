import { DateTime } from 'luxon';
import type {
  AvailabilityContext,
  ResolvedDayWindow,
  TimeOffStatus,
} from '@fadezy/shared';
import { intervalsOverlap } from '@fadezy/shared';

export type MinuteInterval = { startMinute: number; endMinute: number };

/** Luxon weekday: 1=Mon … 7=Sun — matches stored weekday. */
export function weekdayInZone(dateIso: string, timeZone: string): number {
  const dt = DateTime.fromISO(dateIso, { zone: timeZone });
  if (!dt.isValid) {
    throw new Error(`Invalid date or timezone: ${dateIso} / ${timeZone}`);
  }
  return dt.weekday;
}

/**
 * Convert local calendar date + minute-of-day (may be >1440 for overnight)
 * into a UTC DateTime, honoring DST gap/fold via Luxon.
 * Gaps: Luxon shifts forward to the next valid local time.
 * Folds: prefer the earlier offset (before transition) for schedule semantics.
 */
export function localMinuteToUtc(
  dateIso: string,
  minute: number,
  timeZone: string,
): DateTime {
  const dayOffset = Math.floor(minute / 1440);
  const minuteOfDay = ((minute % 1440) + 1440) % 1440;
  const hour = Math.floor(minuteOfDay / 60);
  const minutePart = minuteOfDay % 60;

  const base = DateTime.fromISO(dateIso, { zone: timeZone }).startOf('day').plus({ days: dayOffset });
  let local = base.set({ hour, minute: minutePart, second: 0, millisecond: 0 });

  if (!local.isValid) {
    // DST spring-forward gap: advance to next valid instant in zone.
    local = base.plus({ hours: hour, minutes: minutePart });
  }

  // Ambiguous (fold): keep earlier offset.
  if (local.offset !== local.toUTC().setZone(timeZone).offset) {
    const earlier = DateTime.fromObject(
      {
        year: local.year,
        month: local.month,
        day: local.day,
        hour,
        minute: minutePart,
      },
      { zone: timeZone },
    );
    if (earlier.isValid) local = earlier;
  }

  return local.toUTC();
}

/**
 * Half-open local calendar day [D 00:00, D+1 00:00) as UTC instants.
 * Uses calendar-day arithmetic (not a fixed 24h duration) so DST 23h/25h days are correct.
 */
export function localDayUtcBounds(
  dateIso: string,
  timeZone: string,
): { startUtc: DateTime; endUtc: DateTime } {
  const startLocal = DateTime.fromISO(dateIso, { zone: timeZone }).startOf('day');
  if (!startLocal.isValid) {
    throw new Error(`Invalid date or timezone: ${dateIso} / ${timeZone}`);
  }
  const endLocal = startLocal.plus({ days: 1 });
  return { startUtc: startLocal.toUTC(), endUtc: endLocal.toUTC() };
}

export function subtractBreaks(
  windows: MinuteInterval[],
  breaks: MinuteInterval[],
): ResolvedDayWindow[] {
  let result: MinuteInterval[] = [...windows];
  for (const brk of breaks) {
    const next: MinuteInterval[] = [];
    for (const win of result) {
      if (!intervalsOverlap(win, brk)) {
        next.push(win);
        continue;
      }
      if (brk.startMinute > win.startMinute) {
        next.push({ startMinute: win.startMinute, endMinute: Math.min(brk.startMinute, win.endMinute) });
      }
      if (brk.endMinute < win.endMinute) {
        next.push({ startMinute: Math.max(brk.endMinute, win.startMinute), endMinute: win.endMinute });
      }
    }
    result = next.filter((item) => item.endMinute > item.startMinute);
  }
  return result;
}

export function intersectWindows(
  a: MinuteInterval[],
  b: MinuteInterval[],
): ResolvedDayWindow[] {
  const out: ResolvedDayWindow[] = [];
  for (const left of a) {
    for (const right of b) {
      const startMinute = Math.max(left.startMinute, right.startMinute);
      const endMinute = Math.min(left.endMinute, right.endMinute);
      if (endMinute > startMinute) out.push({ startMinute, endMinute });
    }
  }
  return out.sort((x, y) => x.startMinute - y.startMinute);
}

export function buildAvailabilityContext(input: {
  businessId: string;
  locationId: string;
  membershipId: string | null;
  date: string;
  timezone: string;
  locationClosed: boolean;
  locationWindows: MinuteInterval[];
  locationSource: AvailabilityContext['locationSource'];
  staffWindows: MinuteInterval[];
  staffBreaks: MinuteInterval[];
  timeOffBlocks: Array<{ startsAt: string; endsAt: string; status: TimeOffStatus }>;
  notes: string[];
}): AvailabilityContext {
  const afterBreaks = subtractBreaks(input.staffWindows, input.staffBreaks);
  let staffAvailable = input.locationClosed
    ? []
    : intersectWindows(input.locationWindows, afterBreaks);

  // Approved time off fully blocks the day windows that overlap the UTC range.
  const approved = input.timeOffBlocks.filter((item) => item.status === 'approved');
  if (approved.length && staffAvailable.length) {
    const dayStart = localMinuteToUtc(input.date, 0, input.timezone);
    const dayEnd = localMinuteToUtc(input.date, 2880, input.timezone);
    const blocked = approved.some((block) => {
      const start = DateTime.fromISO(block.startsAt, { zone: 'utc' });
      const end = DateTime.fromISO(block.endsAt, { zone: 'utc' });
      return start < dayEnd && end > dayStart;
    });
    if (blocked) {
      // For foundation: if any approved time-off overlaps the local day, clear availability
      // for that membership/location (full-day or partial still removes remaining windows
      // that fall inside the off range — refine by intersecting remaining minutes).
      const remaining: ResolvedDayWindow[] = [];
      for (const win of staffAvailable) {
        let fragments: MinuteInterval[] = [win];
        for (const block of approved) {
          const blockStartLocal = DateTime.fromISO(block.startsAt, { zone: 'utc' }).setZone(input.timezone);
          const blockEndLocal = DateTime.fromISO(block.endsAt, { zone: 'utc' }).setZone(input.timezone);
          const day = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
          const startMinute = Math.floor(blockStartLocal.diff(day, 'minutes').minutes);
          const endMinute = Math.ceil(blockEndLocal.diff(day, 'minutes').minutes);
          const next: MinuteInterval[] = [];
          for (const frag of fragments) {
            if (!intervalsOverlap(frag, { startMinute, endMinute })) {
              next.push(frag);
              continue;
            }
            if (startMinute > frag.startMinute) {
              next.push({ startMinute: frag.startMinute, endMinute: Math.min(startMinute, frag.endMinute) });
            }
            if (endMinute < frag.endMinute) {
              next.push({
                startMinute: Math.max(endMinute, frag.startMinute),
                endMinute: frag.endMinute,
              });
            }
          }
          fragments = next.filter((item) => item.endMinute > item.startMinute);
        }
        remaining.push(...fragments);
      }
      staffAvailable = remaining;
    }
  }

  return {
    businessId: input.businessId,
    locationId: input.locationId,
    membershipId: input.membershipId,
    date: input.date,
    timezone: input.timezone,
    locationOpen: !input.locationClosed && input.locationWindows.length > 0,
    locationWindows: input.locationWindows,
    locationSource: input.locationSource,
    staffScheduled: input.staffWindows.length > 0,
    staffWindows: input.staffWindows,
    staffBreaks: input.staffBreaks,
    staffAvailableWindows: staffAvailable,
    timeOffBlocks: input.timeOffBlocks,
    notes: input.notes,
  };
}
