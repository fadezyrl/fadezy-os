import { DateTime } from 'luxon';
import type { SlotOffer } from '@fadezy/shared';
import { guestRpcQuery } from '../../db/guest-rpc-pg';
import { buildAvailabilityContext, type MinuteInterval } from '../schedule/availability';
import { generateSlotsForWindows, type ServiceTiming } from './slots';

type GuestSlotContext = {
  businessId: string;
  locationId: string;
  membershipId: string;
  date: string;
  timezone: string;
  locationClosed: boolean;
  locationWindows: Array<{ startMinute: number; endMinute: number }>;
  locationSource: string;
  staffWindows: Array<{ startMinute: number; endMinute: number }>;
  staffBreaks: Array<{ startMinute: number; endMinute: number }>;
  timeOffBlocks: Array<{ startsAt: string; endsAt: string; status: string }>;
  busyRanges: Array<{ busyStartsAt: string; busyEndsAt: string; bookingId?: string }>;
  notes: string[];
  timing: ServiceTiming & {
    priceMinor: number;
    currency: string;
    serviceName: string;
    serviceId: string;
  };
};

function asWindows(
  raw: Array<{ startMinute?: number; endMinute?: number; start_minute?: number; end_minute?: number }>,
): MinuteInterval[] {
  return (raw ?? []).map((item) => ({
    startMinute: item.startMinute ?? item.start_minute ?? 0,
    endMinute: item.endMinute ?? item.end_minute ?? 0,
  }));
}

function normalizeGuestContext(payload: GuestSlotContext): GuestSlotContext {
  return {
    ...payload,
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    locationWindows: asWindows(payload.locationWindows as never),
    staffWindows: asWindows(payload.staffWindows as never),
    staffBreaks: asWindows(payload.staffBreaks as never),
  };
}

export async function fetchGuestSlotContext(input: {
  businessSlug: string;
  locationId: string;
  staffMembershipId: string;
  serviceId: string;
  addonIds: string[];
  date: string;
}): Promise<GuestSlotContext> {
  const { rows } = await guestRpcQuery<{ guest_get_booking_slot_context: GuestSlotContext }>(
    `select public.guest_get_booking_slot_context(
      $1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid[], $6::date
    ) as guest_get_booking_slot_context`,
    [
      input.businessSlug,
      input.locationId,
      input.staffMembershipId,
      input.serviceId,
      input.addonIds,
      input.date,
    ],
  );
  const payload = rows[0]?.guest_get_booking_slot_context;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid guest slot context response');
  }
  return normalizeGuestContext(payload);
}

export async function callCreateGuestBookingRpc(input: {
  businessSlug: string;
  locationId: string;
  staffMembershipId: string;
  serviceId: string;
  addonIds: string[];
  startsAt: string;
  customerFullName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  notes: string | null;
  idempotencyKey: string;
  idempotencyPayloadHash: string;
}): Promise<Record<string, unknown>> {
  const { rows } = await guestRpcQuery<{ create_guest_booking: Record<string, unknown> }>(
    `select public.create_guest_booking(
      $1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid[], $6::timestamptz,
      $7::text, $8::text, $9::text, $10::text, $11::text, $12::text
    ) as create_guest_booking`,
    [
      input.businessSlug,
      input.locationId,
      input.staffMembershipId,
      input.serviceId,
      input.addonIds,
      input.startsAt,
      input.customerFullName,
      input.customerEmail,
      input.customerPhone,
      input.notes,
      input.idempotencyKey,
      input.idempotencyPayloadHash,
    ],
  );
  const payload = rows[0]?.create_guest_booking;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid guest booking response from server');
  }
  return payload;
}

export function buildSlotsFromGuestContext(
  context: GuestSlotContext,
  intervalMinutes?: number,
): { timezone: string; slots: SlotOffer[]; notes: string[]; timing: GuestSlotContext['timing'] } {
  const availability = buildAvailabilityContext({
    businessId: context.businessId,
    locationId: context.locationId,
    membershipId: context.membershipId,
    date: context.date,
    timezone: context.timezone,
    locationClosed: context.locationClosed,
    locationWindows: context.locationWindows,
    locationSource: context.locationSource as never,
    staffWindows: context.staffWindows,
    staffBreaks: context.staffBreaks,
    timeOffBlocks: (context.timeOffBlocks ?? []).map((item) => ({
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status as never,
    })),
    notes: context.notes ?? [],
  });

  if (!availability.locationOpen) {
    return {
      timezone: context.timezone,
      slots: [],
      notes: availability.notes,
      timing: context.timing,
    };
  }

  const day = DateTime.fromISO(context.date, { zone: context.timezone }).startOf('day');
  const busyMinuteBlocks: MinuteInterval[] = (context.busyRanges ?? []).map((row) => {
    const start = DateTime.fromISO(String(row.busyStartsAt), { zone: 'utc' }).setZone(
      context.timezone,
    );
    const end = DateTime.fromISO(String(row.busyEndsAt), { zone: 'utc' }).setZone(context.timezone);
    return {
      startMinute: Math.floor(start.diff(day, 'minutes').minutes),
      endMinute: Math.ceil(end.diff(day, 'minutes').minutes),
    };
  });

  const timing: ServiceTiming = {
    durationMinutes: context.timing.durationMinutes,
    processingMinutes: context.timing.processingMinutes,
    bufferBeforeMinutes: context.timing.bufferBeforeMinutes,
    bufferAfterMinutes: context.timing.bufferAfterMinutes,
    addonDurationMinutes: context.timing.addonDurationMinutes,
  };

  const slots = generateSlotsForWindows({
    date: context.date,
    timezone: context.timezone,
    staffMembershipId: context.membershipId,
    freeWindows: availability.staffAvailableWindows,
    busyMinuteBlocks,
    timing,
    intervalMinutes,
  });

  return {
    timezone: context.timezone,
    slots,
    notes: availability.notes,
    timing: context.timing,
  };
}
