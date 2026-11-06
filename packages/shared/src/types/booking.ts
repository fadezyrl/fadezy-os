export const BOOKING_STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_CHANNELS = ['workspace', 'online'] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export interface Customer {
  id: string;
  businessId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregates for CRM directory/profile.
 *
 * - lifetimeBookingCount: bookings visible to the caller for this customer (location-scoped for staff).
 * - lastVisitAt: max starts_at among visible bookings with starts_at <= now (any status).
 * - nextAppointmentAt: min starts_at among visible confirmed bookings with starts_at >= now.
 * - netCollectedMinor: Σ (amount_paid_minor − amount_refunded_minor) for non-voided sales
 *   with this customer_id (null when caller lacks POS reports permission).
 */
export interface CustomerSummaryMetrics {
  lifetimeBookingCount: number;
  lastVisitAt: string | null;
  nextAppointmentAt: string | null;
  netCollectedMinor: number | null;
  currency: string | null;
  canViewSpend: boolean;
  canViewBookings: boolean;
}

export interface CustomerListItem extends Customer {
  summary: CustomerSummaryMetrics;
}

export const CUSTOMER_LIST_STATUSES = ['active', 'archived', 'all'] as const;
export type CustomerListStatus = (typeof CUSTOMER_LIST_STATUSES)[number];

export const CUSTOMER_LIST_SORTS = ['name', 'created_at'] as const;
export type CustomerListSort = (typeof CUSTOMER_LIST_SORTS)[number];

export interface CustomerListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface PaginatedCustomers {
  items: CustomerListItem[];
  meta: CustomerListMeta;
}

export interface BookingServiceLine {
  id: string;
  bookingId: string;
  serviceId: string | null;
  serviceName: string;
  durationMinutes: number;
  processingMinutes: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
}

export interface BookingAddonLine {
  id: string;
  bookingId: string;
  addonId: string | null;
  addonName: string;
  durationMinutes: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
}

export interface BookingStatusEvent {
  id: string;
  bookingId: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  actorUserId: string | null;
  note: string | null;
  previousStartsAt: string | null;
  previousEndsAt: string | null;
  createdAt: string;
}

export interface Booking {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  customerId: string;
  staffMembershipId: string;
  staffDisplayName: string;
  status: BookingStatus;
  channel: BookingChannel;
  startsAt: string;
  endsAt: string;
  busyStartsAt: string;
  busyEndsAt: string;
  timezone: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  currency: string;
  totalPriceMinor: number;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  referenceCode: string;
  notes: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  services: BookingServiceLine[];
  addons: BookingAddonLine[];
}

export interface SlotOffer {
  startsAt: string;
  endsAt: string;
  busyStartsAt: string;
  busyEndsAt: string;
  localStart: string;
  localEnd: string;
  staffMembershipId: string;
  timezone: string;
}

export interface BookingPermissions {
  canManageAllLocations: boolean;
  canManageAssignedLocations: boolean;
  canCreateWorkspaceBooking: boolean;
  canViewBookings: boolean;
}

export interface PaginatedCustomerBookings {
  items: Booking[];
  meta: CustomerListMeta;
}
