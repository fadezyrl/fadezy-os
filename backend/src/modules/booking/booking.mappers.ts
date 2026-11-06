import type {
  Booking,
  BookingAddonLine,
  BookingChannel,
  BookingServiceLine,
  BookingStatus,
  Customer,
} from '@fadezy/shared';

export function mapCustomer(row: {
  id: string;
  business_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}): Customer {
  return {
    id: row.id,
    businessId: row.business_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapBooking(
  row: {
    id: string;
    business_id: string;
    location_id: string;
    location_name: string;
    customer_id: string;
    staff_membership_id: string;
    staff_display_name: string;
    status: BookingStatus;
    channel: BookingChannel;
    starts_at: string;
    ends_at: string;
    busy_starts_at: string;
    busy_ends_at: string;
    timezone: string;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    currency: string;
    total_price_minor: number | string;
    customer_name: string;
    customer_email: string | null;
    customer_phone: string | null;
    reference_code: string;
    notes: string | null;
    cancellation_reason: string | null;
    cancelled_at: string | null;
    created_by_user_id: string | null;
    created_at: string;
    updated_at: string;
  },
  services: BookingServiceLine[],
  addons: BookingAddonLine[],
): Booking {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: row.location_name,
    customerId: row.customer_id,
    staffMembershipId: row.staff_membership_id,
    staffDisplayName: row.staff_display_name,
    status: row.status,
    channel: row.channel,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    busyStartsAt: row.busy_starts_at,
    busyEndsAt: row.busy_ends_at,
    timezone: row.timezone,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    currency: row.currency,
    totalPriceMinor: Number(row.total_price_minor),
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    referenceCode: row.reference_code,
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    services,
    addons,
  };
}

export function mapServiceLine(row: {
  id: string;
  booking_id: string;
  service_id: string | null;
  service_name: string;
  duration_minutes: number;
  processing_minutes: number;
  price_minor: number | string;
  currency: string;
  sort_order: number;
}): BookingServiceLine {
  return {
    id: row.id,
    bookingId: row.booking_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    processingMinutes: row.processing_minutes,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    sortOrder: row.sort_order,
  };
}

export function mapAddonLine(row: {
  id: string;
  booking_id: string;
  addon_id: string | null;
  addon_name: string;
  duration_minutes: number;
  price_minor: number | string;
  currency: string;
  sort_order: number;
}): BookingAddonLine {
  return {
    id: row.id,
    bookingId: row.booking_id,
    addonId: row.addon_id,
    addonName: row.addon_name,
    durationMinutes: row.duration_minutes,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    sortOrder: row.sort_order,
  };
}
