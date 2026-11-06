import type { SupabaseClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import {
  API_ERROR_CODES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  canTransitionBooking,
  resolveBookingPermissions,
  type Booking,
  type BookingChannel,
  type BookingListQuery,
  type BookingSlotsQuery,
  type BookingStatus,
  type BusinessRole,
  type CreateBookingInput,
  type SlotOffer,
} from '@fadezy/shared';
import { localDayUtcBounds } from '../schedule/availability';
import { mapAddonLine, mapBooking, mapServiceLine } from './booking.mappers';
import {
  buildSlotsFromGuestContext,
  callCreateGuestBookingRpc,
  fetchGuestSlotContext,
} from './guest-slots';
import { buildSlotOffers, computeOccupiedMinutes, hashIdempotencyPayload } from './slots';

export class BookingServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function errorParts(error: unknown): { message: string; lower: string; code: string } {
  if (error && typeof error === 'object') {
    const extended = error as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
    };
    const message = [extended.message, extended.details, extended.hint]
      .filter(Boolean)
      .join(' ');
    if (message) {
      return {
        message,
        lower: message.toLowerCase(),
        code: (extended.code ?? '').toLowerCase(),
      };
    }
  }
  if (error instanceof Error) {
    const message = error.message;
    return { message, lower: message.toLowerCase(), code: '' };
  }
  const message = String(error);
  return { message, lower: message.toLowerCase(), code: '' };
}

function mapError(error: unknown): never {
  if (error instanceof BookingServiceError) throw error;

  const { message, lower, code } = errorParts(error);
  const haystack = `${lower} ${code}`;

  if (
    haystack.includes('booking_conflict') ||
    haystack.includes('23p01') ||
    haystack.includes('exclusion') ||
    haystack.includes('bookings_staff_busy_excl') ||
    haystack.includes('conflicting key value')
  ) {
    throw new BookingServiceError(
      'Selected time conflicts with an existing booking for this staff member',
      API_ERROR_CODES.BOOKING_CONFLICT,
      409,
    );
  }

  if (
    haystack.includes('idempotency_conflict') ||
    (haystack.includes('idempotency') &&
      (haystack.includes('23505') || haystack.includes('reused') || haystack.includes('distinct')))
  ) {
    throw new BookingServiceError(
      'Idempotency key was reused with a different payload',
      API_ERROR_CODES.CONFLICT,
      409,
    );
  }

  if (
    haystack.includes('service_not_online') ||
    haystack.includes('auth_required') ||
    haystack.includes('42501') ||
    (haystack.includes('forbidden') && !haystack.includes('not forbidden'))
  ) {
    const msg = haystack.includes('service_not_online')
      ? 'Service is not bookable online'
      : 'Not permitted';
    throw new BookingServiceError(msg, API_ERROR_CODES.FORBIDDEN, 403);
  }

  if (haystack.includes('forbidden')) {
    throw new BookingServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }

  if (
    haystack.includes('not_found') ||
    haystack.includes('p0002') ||
    haystack.includes('booking_not_found') ||
    haystack.includes('business_not_found') ||
    haystack.includes('location_not_found') ||
    haystack.includes('service_not_found') ||
    haystack.includes('customer_not_found')
  ) {
    throw new BookingServiceError('Resource not found', API_ERROR_CODES.NOT_FOUND, 404);
  }

  if (haystack.includes('customer_archived')) {
    throw new BookingServiceError(
      'Customer is archived',
      API_ERROR_CODES.CUSTOMER_ARCHIVED,
      422,
    );
  }

  if (
    haystack.includes('22023') ||
    haystack.includes('validation_error') ||
    haystack.includes('staff_invalid') ||
    haystack.includes('staff_location_invalid') ||
    haystack.includes('staff_service_invalid') ||
    haystack.includes('addon_invalid') ||
    haystack.includes('customer_required') ||
    haystack.includes('service_location_unavailable') ||
    haystack.includes('invalid_status')
  ) {
    const validationMessage =
      haystack.includes('staff_invalid') || haystack.includes('staff_location_invalid')
        ? 'Staff member is not eligible for this booking'
        : haystack.includes('addon_invalid')
          ? 'One or more add-ons are invalid for this service'
          : haystack.includes('invalid_status')
            ? 'Invalid status transition'
            : message || 'Validation failed';
    throw new BookingServiceError(validationMessage, API_ERROR_CODES.VALIDATION_ERROR, 422);
  }

  throw new BookingServiceError(
    'Unable to complete booking operation',
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
    throw new BookingServiceError('Business not found or not permitted', API_ERROR_CODES.NOT_FOUND, 404);
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

function assertCanManageLocation(
  role: BusinessRole,
  assignedLocationIds: string[],
  locationId: string,
): void {
  const permissions = resolveBookingPermissions(role);
  if (permissions.canManageAllLocations) return;
  if (permissions.canManageAssignedLocations && assignedLocationIds.includes(locationId)) return;
  throw new BookingServiceError('Not permitted for this location', API_ERROR_CODES.FORBIDDEN, 403);
}

async function loadBookingBundle(
  client: SupabaseClient,
  bookingId: string,
): Promise<Booking | null> {
  const { data: booking, error } = await client
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) mapError(error);
  if (!booking) return null;
  const [{ data: services }, { data: addons }] = await Promise.all([
    client.from('booking_services').select('*').eq('booking_id', bookingId).order('sort_order'),
    client.from('booking_addons').select('*').eq('booking_id', bookingId).order('sort_order'),
  ]);
  return mapBooking(booking, (services ?? []).map(mapServiceLine), (addons ?? []).map(mapAddonLine));
}

export async function getBookingPermissions(
  client: SupabaseClient,
  businessId: string,
  userId: string,
) {
  const caller = await getCaller(client, businessId, userId);
  return resolveBookingPermissions(caller.role);
}

type ResolvedService = {
  service: {
    id: string;
    name: string;
    duration_minutes: number;
    processing_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    price_minor: number;
    currency: string;
    is_bookable_online: boolean;
  };
  priceMinor: number;
  addons: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    price_minor: number;
    currency: string;
  }>;
  timing: {
    durationMinutes: number;
    processingMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    addonDurationMinutes: number;
    appointmentMinutes: number;
    totalBusyMinutes: number;
  };
};

async function resolveServiceTiming(
  client: SupabaseClient,
  businessId: string,
  locationId: string,
  serviceId: string,
  addonIds: string[],
  requireOnline: boolean,
): Promise<ResolvedService> {
  const { data: service, error } = await client
    .from('services')
    .select('*')
    .eq('id', serviceId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) mapError(error);
  if (!service || service.archived_at || !service.is_active) {
    throw new BookingServiceError('Service not found or inactive', API_ERROR_CODES.NOT_FOUND, 404);
  }
  if (requireOnline && !service.is_bookable_online) {
    throw new BookingServiceError('Service is not bookable online', API_ERROR_CODES.FORBIDDEN, 403);
  }

  const { data: locationSetting } = await client
    .from('service_location_settings')
    .select('*')
    .eq('service_id', serviceId)
    .eq('location_id', locationId)
    .maybeSingle();
  if (locationSetting && locationSetting.is_available === false) {
    throw new BookingServiceError(
      'Service is not available at this location',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }
  const priceMinor =
    locationSetting?.price_minor != null
      ? Number(locationSetting.price_minor)
      : Number(service.price_minor);

  let addons: ResolvedService['addons'] = [];
  if (addonIds.length) {
    const { data: addonRows, error: addonError } = await client
      .from('service_addons')
      .select('*')
      .eq('business_id', businessId)
      .in('id', addonIds);
    if (addonError) mapError(addonError);
    const { data: links } = await client
      .from('service_addon_links')
      .select('addon_id')
      .eq('service_id', serviceId)
      .in('addon_id', addonIds);
    const linked = new Set((links ?? []).map((row) => row.addon_id));
    addons = (addonRows ?? [])
      .filter((row) => !row.archived_at && row.is_active && linked.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        duration_minutes: row.duration_minutes,
        price_minor: Number(row.price_minor),
        currency: row.currency,
      }));
    if (addons.length !== addonIds.length) {
      throw new BookingServiceError(
        'One or more add-ons are invalid for this service',
        API_ERROR_CODES.VALIDATION_ERROR,
        422,
      );
    }
  }

  const addonDurationMinutes = addons.reduce((sum, item) => sum + item.duration_minutes, 0);
  const timingInput = {
    durationMinutes: service.duration_minutes,
    processingMinutes: service.processing_minutes ?? 0,
    bufferBeforeMinutes: service.buffer_before_minutes ?? 0,
    bufferAfterMinutes: service.buffer_after_minutes ?? 0,
    addonDurationMinutes,
  };
  return {
    service: {
      id: service.id,
      name: service.name,
      duration_minutes: service.duration_minutes,
      processing_minutes: service.processing_minutes ?? 0,
      buffer_before_minutes: service.buffer_before_minutes ?? 0,
      buffer_after_minutes: service.buffer_after_minutes ?? 0,
      price_minor: Number(service.price_minor),
      currency: service.currency,
      is_bookable_online: service.is_bookable_online,
    },
    priceMinor,
    addons,
    timing: { ...timingInput, ...computeOccupiedMinutes(timingInput) },
  };
}

async function assertStaffEligible(
  client: SupabaseClient,
  businessId: string,
  locationId: string,
  staffMembershipId: string,
  serviceId: string,
): Promise<{ displayName: string }> {
  const { data: member } = await client
    .from('business_members')
    .select('id, business_id, membership_status, deactivated_at')
    .eq('id', staffMembershipId)
    .maybeSingle();
  if (
    !member ||
    member.business_id !== businessId ||
    member.membership_status !== 'active' ||
    member.deactivated_at
  ) {
    throw new BookingServiceError('Staff member not available', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }
  const { data: locAssign } = await client
    .from('staff_location_assignments')
    .select('id')
    .eq('membership_id', staffMembershipId)
    .eq('location_id', locationId)
    .maybeSingle();
  if (!locAssign) {
    throw new BookingServiceError(
      'Staff is not assigned to this location',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }
  const { data: svcAssign } = await client
    .from('staff_service_assignments')
    .select('id')
    .eq('membership_id', staffMembershipId)
    .eq('service_id', serviceId)
    .maybeSingle();
  if (!svcAssign) {
    throw new BookingServiceError(
      'Staff is not eligible for this service',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }
  const { data: profile } = await client
    .from('staff_profiles')
    .select('display_name')
    .eq('membership_id', staffMembershipId)
    .maybeSingle();
  return { displayName: profile?.display_name ?? 'Staff' };
}

function startsAtIsOffered(slots: SlotOffer[], startsAt: string): SlotOffer | null {
  return slots.find((slot) => slot.startsAt === startsAt) ?? null;
}

function normalizeStartsAtUtc(startsAt: string): string {
  const parsed = DateTime.fromISO(startsAt, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new BookingServiceError('Invalid startsAt', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }
  const iso = parsed.toUTC().toISO();
  if (!iso) {
    throw new BookingServiceError('Invalid startsAt', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }
  return iso;
}

function parseRpcBookingId(data: unknown): string {
  if (!data || typeof data !== 'object') {
    throw new BookingServiceError(
      'Invalid booking response from server',
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
    );
  }
  const row = data as Record<string, unknown>;
  if (typeof row.id === 'string') return row.id;
  // Defensive: older double-wrapped to_jsonb shape
  const nested = row.to_jsonb;
  if (nested && typeof nested === 'object' && typeof (nested as { id?: unknown }).id === 'string') {
    return (nested as { id: string }).id;
  }
  throw new BookingServiceError(
    'Invalid booking response from server',
    API_ERROR_CODES.INTERNAL_ERROR,
    500,
  );
}

function bookingFromGuestPublic(
  data: Record<string, unknown>,
  locationId: string,
  staffMembershipId: string,
): Booking {
  const startsAt = String(data.startsAt ?? '');
  const endsAt = String(data.endsAt ?? startsAt);
  return {
    id: String(data.id),
    businessId: String(data.businessId),
    locationId,
    locationName: String(data.locationName ?? ''),
    customerId: '',
    staffMembershipId,
    staffDisplayName: String(data.staffDisplayName ?? 'Staff'),
    status: (data.status as BookingStatus) ?? 'confirmed',
    channel: (data.channel as BookingChannel) ?? 'online',
    startsAt,
    endsAt,
    busyStartsAt: startsAt,
    busyEndsAt: endsAt,
    timezone: String(data.timezone ?? 'UTC'),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    currency: String(data.currency ?? ''),
    totalPriceMinor: Number(data.totalPriceMinor ?? 0),
    customerName: String(data.customerName ?? ''),
    customerEmail: null,
    customerPhone: null,
    referenceCode: String(data.referenceCode ?? ''),
    notes: null,
    cancellationReason: null,
    cancelledAt: null,
    createdByUserId: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    services: [],
    addons: [],
  };
}

export async function listSlots(
  client: SupabaseClient,
  businessId: string,
  query: BookingSlotsQuery,
  options?: { requireOnline?: boolean; userId?: string },
): Promise<{ timezone: string; slots: SlotOffer[]; notes: string[] }> {
  if (options?.userId) {
    const caller = await getCaller(client, businessId, options.userId);
    assertCanManageLocation(caller.role, caller.locationIds, query.locationId);
  }

  const resolved = await resolveServiceTiming(
    client,
    businessId,
    query.locationId,
    query.serviceId,
    query.addonIds,
    Boolean(options?.requireOnline),
  );
  await assertStaffEligible(
    client,
    businessId,
    query.locationId,
    query.staffMembershipId,
    query.serviceId,
  );

  return buildSlotOffers(client, {
    businessId,
    locationId: query.locationId,
    staffMembershipId: query.staffMembershipId,
    date: query.date,
    timing: {
      durationMinutes: resolved.timing.durationMinutes,
      processingMinutes: resolved.timing.processingMinutes,
      bufferBeforeMinutes: resolved.timing.bufferBeforeMinutes,
      bufferAfterMinutes: resolved.timing.bufferAfterMinutes,
      addonDurationMinutes: resolved.timing.addonDurationMinutes,
    },
    intervalMinutes: query.intervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES,
  });
}

export async function listGuestSlots(
  businessSlug: string,
  query: BookingSlotsQuery,
): Promise<{ timezone: string; slots: SlotOffer[]; notes: string[] }> {
  try {
    const context = await fetchGuestSlotContext({
      businessSlug,
      locationId: query.locationId,
      staffMembershipId: query.staffMembershipId,
      serviceId: query.serviceId,
      addonIds: query.addonIds ?? [],
      date: query.date,
    });
    const built = buildSlotsFromGuestContext(
      context,
      query.intervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES,
    );
    return { timezone: built.timezone, slots: built.slots, notes: built.notes };
  } catch (error) {
    mapError(error);
  }
}

export async function createBooking(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CreateBookingInput,
): Promise<Booking> {
  const caller = await getCaller(client, businessId, userId);
  assertCanManageLocation(caller.role, caller.locationIds, input.locationId);
  if (!resolveBookingPermissions(caller.role).canCreateWorkspaceBooking) {
    throw new BookingServiceError('Not permitted to create bookings', API_ERROR_CODES.FORBIDDEN, 403);
  }

  const { data: location, error: locationError } = await client
    .from('business_locations')
    .select('id, name, timezone, business_id')
    .eq('id', input.locationId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (locationError) mapError(locationError);
  if (!location?.timezone) {
    throw new BookingServiceError('Location not found', API_ERROR_CODES.NOT_FOUND, 404);
  }

  const resolved = await resolveServiceTiming(
    client,
    businessId,
    input.locationId,
    input.serviceId,
    input.addonIds ?? [],
    false,
  );
  await assertStaffEligible(
    client,
    businessId,
    input.locationId,
    input.staffMembershipId,
    input.serviceId,
  );

  const normalizedStartsAt = normalizeStartsAtUtc(input.startsAt);
  const customerId = input.customerId ?? null;

  const payloadHash = hashIdempotencyPayload({
    businessId,
    locationId: input.locationId,
    staffMembershipId: input.staffMembershipId,
    serviceId: input.serviceId,
    addonIds: [...(input.addonIds ?? [])].sort(),
    startsAt: normalizedStartsAt,
    customerId,
    customer: input.customer ?? null,
    notes: input.notes ?? null,
    channel: 'workspace' as BookingChannel,
  });

  const { data: existingIdem, error: idemError } = await client
    .from('bookings')
    .select('id, idempotency_payload_hash')
    .eq('business_id', businessId)
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle();
  if (idemError) mapError(idemError);
  if (existingIdem) {
    if (existingIdem.idempotency_payload_hash !== payloadHash) {
      throw new BookingServiceError(
        'Idempotency key was reused with a different payload',
        API_ERROR_CODES.CONFLICT,
        409,
      );
    }
    const replay = await loadBookingBundle(client, existingIdem.id);
    if (!replay) {
      throw new BookingServiceError('Booking not found', API_ERROR_CODES.NOT_FOUND, 404);
    }
    return replay;
  }

  const startsAtDt = DateTime.fromISO(normalizedStartsAt, { zone: 'utc' });
  const localDate = startsAtDt.setZone(location.timezone).toISODate();
  if (!localDate) {
    throw new BookingServiceError(
      'Unable to resolve local date for startsAt',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  const offered = await buildSlotOffers(client, {
    businessId,
    locationId: input.locationId,
    staffMembershipId: input.staffMembershipId,
    date: localDate,
    timing: {
      durationMinutes: resolved.timing.durationMinutes,
      processingMinutes: resolved.timing.processingMinutes,
      bufferBeforeMinutes: resolved.timing.bufferBeforeMinutes,
      bufferAfterMinutes: resolved.timing.bufferAfterMinutes,
      addonDurationMinutes: resolved.timing.addonDurationMinutes,
    },
    intervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
  });

  const slot = startsAtIsOffered(offered.slots, normalizedStartsAt);
  if (!slot) {
    throw new BookingServiceError(
      'Selected start time is not available',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  const { data: rpcData, error: rpcError } = await client.rpc('create_workspace_booking', {
    p_business_id: businessId,
    p_location_id: input.locationId,
    p_staff_membership_id: input.staffMembershipId,
    p_service_id: input.serviceId,
    p_addon_ids: input.addonIds ?? [],
    p_starts_at: slot.startsAt,
    p_customer_id: customerId,
    p_customer_full_name: input.customer?.fullName ?? null,
    p_customer_email: input.customer?.email ?? null,
    p_customer_phone: input.customer?.phone ?? null,
    p_customer_notes: input.customer?.notes ?? null,
    p_notes: input.notes ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_idempotency_payload_hash: payloadHash,
  });
  if (rpcError) mapError(rpcError);

  const bookingId = parseRpcBookingId(rpcData);
  const booking = await loadBookingBundle(client, bookingId);
  if (!booking) {
    throw new BookingServiceError('Booking not found after create', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return booking;
}

export async function createGuestBooking(
  businessSlug: string,
  input: CreateBookingInput,
): Promise<Booking> {
  const normalizedStartsAt = normalizeStartsAtUtc(input.startsAt);
  const addonIds = input.addonIds ?? [];

  const startsAtDt = DateTime.fromISO(normalizedStartsAt, { zone: 'utc' });

  let guestContext: Awaited<ReturnType<typeof fetchGuestSlotContext>>;
  try {
    const provisionalDate = startsAtDt.toISODate();
    if (!provisionalDate) {
      throw new BookingServiceError('Invalid startsAt', API_ERROR_CODES.VALIDATION_ERROR, 422);
    }
    guestContext = await fetchGuestSlotContext({
      businessSlug,
      locationId: input.locationId,
      staffMembershipId: input.staffMembershipId,
      serviceId: input.serviceId,
      addonIds,
      date: provisionalDate,
    });
  } catch (error) {
    mapError(error);
  }

  const localDate = startsAtDt.setZone(guestContext.timezone).toISODate();
  if (!localDate) {
    throw new BookingServiceError('Invalid startsAt', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }

  let slotContext = guestContext;
  if (localDate !== guestContext.date) {
    try {
      slotContext = await fetchGuestSlotContext({
        businessSlug,
        locationId: input.locationId,
        staffMembershipId: input.staffMembershipId,
        serviceId: input.serviceId,
        addonIds,
        date: localDate,
      });
    } catch (error) {
      mapError(error);
    }
  }

  const offered = buildSlotsFromGuestContext(slotContext, DEFAULT_SLOT_INTERVAL_MINUTES);
  const slot = startsAtIsOffered(offered.slots, normalizedStartsAt);
  if (!slot) {
    throw new BookingServiceError(
      'Selected start time is not available',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  if (!input.customer?.fullName?.trim()) {
    throw new BookingServiceError('Customer is required', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }

  const payloadHash = hashIdempotencyPayload({
    businessId: slotContext.businessId,
    locationId: input.locationId,
    staffMembershipId: input.staffMembershipId,
    serviceId: input.serviceId,
    addonIds: [...addonIds].sort(),
    startsAt: normalizedStartsAt,
    customerId: null,
    customer: input.customer,
    notes: input.notes ?? null,
    channel: 'online' as BookingChannel,
  });

  let rpcData: Record<string, unknown>;
  try {
    rpcData = await callCreateGuestBookingRpc({
      businessSlug,
      locationId: input.locationId,
      staffMembershipId: input.staffMembershipId,
      serviceId: input.serviceId,
      addonIds,
      startsAt: slot.startsAt,
      customerFullName: input.customer.fullName,
      customerEmail: input.customer.email ?? null,
      customerPhone: input.customer.phone ?? null,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey,
      idempotencyPayloadHash: payloadHash,
    });
  } catch (error) {
    mapError(error);
  }

  return bookingFromGuestPublic(rpcData, input.locationId, input.staffMembershipId);
}

export async function listBookings(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: BookingListQuery,
): Promise<Booking[]> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolveBookingPermissions(caller.role);
  if (!permissions.canViewBookings) {
    throw new BookingServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }

  let q = client
    .from('bookings')
    .select('*')
    .eq('business_id', businessId)
    .order('starts_at', { ascending: true });

  if (!permissions.canManageAllLocations) {
    if (!caller.locationIds.length) return [];
    q = q.in('location_id', caller.locationIds);
  }
  if (query.locationId) {
    assertCanManageLocation(caller.role, caller.locationIds, query.locationId);
    q = q.eq('location_id', query.locationId);
  }
  if (query.staffMembershipId) q = q.eq('staff_membership_id', query.staffMembershipId);
  if (query.status) q = q.eq('status', query.status);

  if (query.date) {
    if (!query.locationId) {
      throw new BookingServiceError(
        'locationId is required when filtering by date',
        API_ERROR_CODES.VALIDATION_ERROR,
        422,
      );
    }
    const { data: location, error: locError } = await client
      .from('business_locations')
      .select('id, business_id, timezone')
      .eq('id', query.locationId)
      .eq('business_id', businessId)
      .maybeSingle();
    if (locError) mapError(locError);
    if (!location?.timezone) {
      throw new BookingServiceError('Location not found', API_ERROR_CODES.NOT_FOUND, 404);
    }
    let bounds: { startUtc: DateTime; endUtc: DateTime };
    try {
      bounds = localDayUtcBounds(query.date, location.timezone);
    } catch {
      throw new BookingServiceError(
        'Invalid date or location timezone',
        API_ERROR_CODES.VALIDATION_ERROR,
        422,
      );
    }
    const startIso = bounds.startUtc.toISO();
    const endIso = bounds.endUtc.toISO();
    if (!startIso || !endIso) {
      throw new BookingServiceError(
        'Unable to resolve local day bounds',
        API_ERROR_CODES.VALIDATION_ERROR,
        422,
      );
    }
    q = q.gte('starts_at', startIso).lt('starts_at', endIso);
  }
  if (query.from) q = q.gte('starts_at', query.from);
  if (query.to) q = q.lt('starts_at', query.to);

  // Pagination only after location-local day (and other) filters are applied.
  q = q.range(query.offset, query.offset + query.limit - 1);

  const { data, error } = await q;
  if (error) mapError(error);
  const ids = (data ?? []).map((row) => row.id);
  if (!ids.length) return [];
  const [{ data: services }, { data: addons }] = await Promise.all([
    client.from('booking_services').select('*').in('booking_id', ids),
    client.from('booking_addons').select('*').in('booking_id', ids),
  ]);
  return (data ?? []).map((row) =>
    mapBooking(
      row,
      (services ?? []).filter((item) => item.booking_id === row.id).map(mapServiceLine),
      (addons ?? []).filter((item) => item.booking_id === row.id).map(mapAddonLine),
    ),
  );
}

export async function getBooking(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  bookingId: string,
): Promise<Booking> {
  const caller = await getCaller(client, businessId, userId);
  const booking = await loadBookingBundle(client, bookingId);
  if (!booking || booking.businessId !== businessId) {
    throw new BookingServiceError('Booking not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  assertCanManageLocation(caller.role, caller.locationIds, booking.locationId);
  return booking;
}

export async function transitionBooking(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  bookingId: string,
  toStatus: 'completed' | 'cancelled' | 'no_show',
  note?: string | null,
): Promise<Booking> {
  const existing = await getBooking(client, businessId, userId, bookingId);
  if (!canTransitionBooking(existing.status, toStatus)) {
    throw new BookingServiceError(
      'Invalid status transition',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }
  const { error } = await client.rpc('transition_booking_status', {
    p_booking_id: bookingId,
    p_to_status: toStatus,
    p_note: note ?? null,
  });
  if (error) mapError(error);
  const loaded = await loadBookingBundle(client, bookingId);
  if (!loaded) {
    throw new BookingServiceError('Booking not found after update', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return loaded;
}

export async function rescheduleBooking(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  bookingId: string,
  startsAtIso: string,
): Promise<Booking> {
  const existing = await getBooking(client, businessId, userId, bookingId);
  if (existing.status !== 'confirmed') {
    throw new BookingServiceError(
      'Only confirmed bookings can be rescheduled',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  const serviceId = existing.services[0]?.serviceId;
  if (!serviceId) {
    throw new BookingServiceError(
      'Booking has no service line',
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
    );
  }
  const addonIds = existing.addons
    .map((item) => item.addonId)
    .filter((id): id is string => Boolean(id));

  const resolved = await resolveServiceTiming(
    client,
    businessId,
    existing.locationId,
    serviceId,
    addonIds,
    false,
  );
  const normalizedStartsAt = normalizeStartsAtUtc(startsAtIso);
  const startsAt = DateTime.fromISO(normalizedStartsAt, { zone: 'utc' });
  const localDate = startsAt.setZone(existing.timezone).toISODate();
  if (!localDate) {
    throw new BookingServiceError('Invalid startsAt', API_ERROR_CODES.VALIDATION_ERROR, 422);
  }

  const offered = await buildSlotOffers(client, {
    businessId,
    locationId: existing.locationId,
    staffMembershipId: existing.staffMembershipId,
    date: localDate,
    timing: {
      durationMinutes: resolved.timing.durationMinutes,
      processingMinutes: resolved.timing.processingMinutes,
      bufferBeforeMinutes: resolved.timing.bufferBeforeMinutes,
      bufferAfterMinutes: resolved.timing.bufferAfterMinutes,
      addonDurationMinutes: resolved.timing.addonDurationMinutes,
    },
    excludeBookingId: bookingId,
  });

  const slot = startsAtIsOffered(offered.slots, normalizedStartsAt);
  if (!slot) {
    throw new BookingServiceError(
      'Selected start time is not available',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }

  const { error } = await client.rpc('reschedule_booking_times', {
    p_booking_id: bookingId,
    p_starts_at: slot.startsAt,
  });
  if (error) mapError(error);

  return getBooking(client, businessId, userId, bookingId);
}
