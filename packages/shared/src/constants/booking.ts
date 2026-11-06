import type { BusinessRole } from '../types/business';
import type { BookingPermissions, BookingStatus } from '../types/booking';

export const DEFAULT_SLOT_INTERVAL_MINUTES = 5;

export const BOOKING_ACTIONS = [
  'manage_all_location_bookings',
  'manage_assigned_location_bookings',
  'create_workspace_booking',
  'view_bookings',
] as const;

export type BookingAction = (typeof BOOKING_ACTIONS)[number];

const ROLE_CAPABILITIES: Record<BusinessRole, ReadonlySet<BookingAction>> = {
  owner: new Set(BOOKING_ACTIONS),
  manager: new Set(BOOKING_ACTIONS),
  staff: new Set([
    'manage_assigned_location_bookings',
    'create_workspace_booking',
    'view_bookings',
  ]),
};

export function canPerformBookingAction(role: BusinessRole, action: BookingAction): boolean {
  return ROLE_CAPABILITIES[role]?.has(action) ?? false;
}

export function resolveBookingPermissions(role: BusinessRole): BookingPermissions {
  return {
    canManageAllLocations: canPerformBookingAction(role, 'manage_all_location_bookings'),
    canManageAssignedLocations: canPerformBookingAction(
      role,
      'manage_assigned_location_bookings',
    ),
    canCreateWorkspaceBooking: canPerformBookingAction(role, 'create_workspace_booking'),
    canViewBookings: canPerformBookingAction(role, 'view_bookings'),
  };
}

export const BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return (BOOKING_TRANSITIONS[from] ?? []).includes(to);
}
