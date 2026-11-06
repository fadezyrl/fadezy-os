import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_SLOT_INTERVAL_MINUTES,
  intervalsOverlap,
  type SlotOffer,
} from '@fadezy/shared';
import { localMinuteToUtc, type MinuteInterval } from '../schedule/availability';
import { resolveAvailabilityContextInternal } from '../schedule/availability-context';

export type ServiceTiming = {
  durationMinutes: number;
  processingMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  addonDurationMinutes: number;
};

export function computeOccupiedMinutes(timing: ServiceTiming): {
  appointmentMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  totalBusyMinutes: number;
} {
  const appointmentMinutes =
    timing.durationMinutes + timing.processingMinutes + timing.addonDurationMinutes;
  return {
    appointmentMinutes,
    bufferBeforeMinutes: timing.bufferBeforeMinutes,
    bufferAfterMinutes: timing.bufferAfterMinutes,
    totalBusyMinutes:
      timing.bufferBeforeMinutes + appointmentMinutes + timing.bufferAfterMinutes,
  };
}

function subtractBusyFromWindows(
  windows: MinuteInterval[],
  busy: MinuteInterval[],
): MinuteInterval[] {
  let result = [...windows];
  for (const block of busy) {
    const next: MinuteInterval[] = [];
    for (const win of result) {
      if (!intervalsOverlap(win, block)) {
        next.push(win);
        continue;
      }
      if (block.startMinute > win.startMinute) {
        next.push({
          startMinute: win.startMinute,
          endMinute: Math.min(block.startMinute, win.endMinute),
        });
      }
      if (block.endMinute < win.endMinute) {
        next.push({
          startMinute: Math.max(block.endMinute, win.startMinute),
          endMinute: win.endMinute,
        });
      }
    }
    result = next.filter((item) => item.endMinute > item.startMinute);
  }
  return result;
}

export function generateSlotsForWindows(input: {
  date: string;
  timezone: string;
  staffMembershipId: string;
  freeWindows: MinuteInterval[];
  busyMinuteBlocks: MinuteInterval[];
  timing: ServiceTiming;
  intervalMinutes?: number;
}): SlotOffer[] {
  const interval = input.intervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES;
  const occupied = computeOccupiedMinutes(input.timing);
  const free = subtractBusyFromWindows(input.freeWindows, input.busyMinuteBlocks);
  const slots: SlotOffer[] = [];

  for (const win of free) {
    const earliestStart = win.startMinute + occupied.bufferBeforeMinutes;
    const latestStart =
      win.endMinute - occupied.bufferAfterMinutes - occupied.appointmentMinutes;

    let cursor = Math.ceil(earliestStart / interval) * interval;
    if (cursor < earliestStart) cursor += interval;
    while (cursor <= latestStart) {
      const apptEnd = cursor + occupied.appointmentMinutes;
      const busyStart = cursor - occupied.bufferBeforeMinutes;
      const busyEnd = apptEnd + occupied.bufferAfterMinutes;
      if (busyStart >= win.startMinute && busyEnd <= win.endMinute) {
        const startsAt = localMinuteToUtc(input.date, cursor, input.timezone);
        const endsAt = localMinuteToUtc(input.date, apptEnd, input.timezone);
        const busyStartsAt = localMinuteToUtc(input.date, busyStart, input.timezone);
        const busyEndsAt = localMinuteToUtc(input.date, busyEnd, input.timezone);
        if (startsAt.isValid && endsAt.isValid && busyStartsAt.isValid && busyEndsAt.isValid) {
          const localStart = DateTime.fromISO(input.date, { zone: input.timezone })
            .startOf('day')
            .plus({ minutes: cursor });
          const localEnd = DateTime.fromISO(input.date, { zone: input.timezone })
            .startOf('day')
            .plus({ minutes: apptEnd });
          if (localStart.isValid && localEnd.isValid) {
            slots.push({
              startsAt: startsAt.toISO()!,
              endsAt: endsAt.toISO()!,
              busyStartsAt: busyStartsAt.toISO()!,
              busyEndsAt: busyEndsAt.toISO()!,
              localStart: localStart.toFormat("yyyy-MM-dd'T'HH:mm"),
              localEnd: localEnd.toFormat("yyyy-MM-dd'T'HH:mm"),
              staffMembershipId: input.staffMembershipId,
              timezone: input.timezone,
            });
          }
        }
      }
      cursor += interval;
    }
  }

  return slots;
}

export async function loadBusyMinuteBlocks(
  client: SupabaseClient,
  staffMembershipId: string,
  date: string,
  timezone: string,
  excludeBookingId?: string | null,
): Promise<MinuteInterval[]> {
  const dayStart = localMinuteToUtc(date, 0, timezone);
  const dayEnd = localMinuteToUtc(date, 2880, timezone);
  const { data, error } = await client.rpc('list_staff_busy_ranges', {
    p_staff_membership_id: staffMembershipId,
    p_from: dayStart.toISO(),
    p_to: dayEnd.toISO(),
  });
  if (error) throw error;

  const day = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  const blocks: MinuteInterval[] = [];
  for (const row of data ?? []) {
    if (excludeBookingId && row.booking_id === excludeBookingId) continue;
    const start = DateTime.fromISO(row.busy_starts_at, { zone: 'utc' }).setZone(timezone);
    const end = DateTime.fromISO(row.busy_ends_at, { zone: 'utc' }).setZone(timezone);
    blocks.push({
      startMinute: Math.floor(start.diff(day, 'minutes').minutes),
      endMinute: Math.ceil(end.diff(day, 'minutes').minutes),
    });
  }
  return blocks;
}

export async function buildSlotOffers(
  client: SupabaseClient,
  input: {
    businessId: string;
    locationId: string;
    staffMembershipId: string;
    date: string;
    timing: ServiceTiming;
    intervalMinutes?: number;
    excludeBookingId?: string | null;
  },
): Promise<{ timezone: string; slots: SlotOffer[]; notes: string[] }> {
  const context = await resolveAvailabilityContextInternal(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    membershipId: input.staffMembershipId,
    date: input.date,
  });

  if (!context.locationOpen) {
    return { timezone: context.timezone, slots: [], notes: context.notes };
  }

  const busy = await loadBusyMinuteBlocks(
    client,
    input.staffMembershipId,
    input.date,
    context.timezone,
    input.excludeBookingId,
  );

  const slots = generateSlotsForWindows({
    date: input.date,
    timezone: context.timezone,
    staffMembershipId: input.staffMembershipId,
    freeWindows: context.staffAvailableWindows,
    busyMinuteBlocks: busy,
    timing: input.timing,
    intervalMinutes: input.intervalMinutes,
  });

  return { timezone: context.timezone, slots, notes: context.notes };
}

export function hashIdempotencyPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}
