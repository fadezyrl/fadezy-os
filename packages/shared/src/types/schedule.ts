export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Luxon-aligned: 1 = Monday … 7 = Sunday */
export type Weekday = (typeof WEEKDAYS)[number];

export const LOCATION_HOURS_MODES = ['inherit', 'custom'] as const;
export type LocationHoursMode = (typeof LOCATION_HOURS_MODES)[number];

export const SCHEDULE_EXCEPTION_KINDS = ['closed', 'special_hours'] as const;
export type ScheduleExceptionKind = (typeof SCHEDULE_EXCEPTION_KINDS)[number];

export const TIME_OFF_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];

export const TIME_OFF_CATEGORIES = ['vacation', 'sick', 'personal', 'other'] as const;
export type TimeOffCategory = (typeof TIME_OFF_CATEGORIES)[number];

export interface TimeInterval {
  startMinute: number;
  endMinute: number;
}

export interface WeeklyHourInterval extends TimeInterval {
  id: string;
  weekday: Weekday;
  sortOrder: number;
}

export interface BusinessOperatingHours {
  businessId: string;
  intervals: WeeklyHourInterval[];
  updatedAt: string | null;
}

export interface LocationOperatingHours {
  businessId: string;
  locationId: string;
  hoursMode: LocationHoursMode;
  /** Effective intervals after inherit resolution when requested. */
  intervals: WeeklyHourInterval[];
  source: 'business' | 'location';
  timezone: string;
  updatedAt: string | null;
}

export interface ScheduleDateException {
  id: string;
  businessId: string;
  locationId: string | null;
  exceptionDate: string;
  kind: ScheduleExceptionKind;
  label: string | null;
  intervals: TimeInterval[];
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffWeeklyBreak extends TimeInterval {
  id: string;
  weekday: Weekday;
  isPaid: boolean;
  sortOrder: number;
}

export interface StaffWeeklyInterval extends TimeInterval {
  id: string;
  weekday: Weekday;
  locationId: string;
  sortOrder: number;
}

export interface StaffWeeklySchedule {
  id: string;
  businessId: string;
  membershipId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededAt: string | null;
  label: string | null;
  intervals: StaffWeeklyInterval[];
  breaks: StaffWeeklyBreak[];
  createdAt: string;
  updatedAt: string;
}

export interface StaffTimeOff {
  id: string;
  businessId: string;
  membershipId: string;
  locationId: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  isFullDay: boolean;
  category: TimeOffCategory;
  reason: string | null;
  status: TimeOffStatus;
  requestedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulePermissions {
  canManageHours: boolean;
  canManageStaffSchedules: boolean;
  canRequestTimeOff: boolean;
  canReviewTimeOff: boolean;
  canViewAllSchedules: boolean;
}

/** Resolved local windows for one calendar date (minutes from local midnight; overnight may exceed 1440). */
export interface ResolvedDayWindow {
  startMinute: number;
  endMinute: number;
}

export interface AvailabilityContext {
  businessId: string;
  locationId: string;
  membershipId: string | null;
  date: string;
  timezone: string;
  locationOpen: boolean;
  locationWindows: ResolvedDayWindow[];
  locationSource: 'closed_exception' | 'special_hours' | 'weekly' | 'inherit_weekly' | 'none';
  staffScheduled: boolean;
  staffWindows: ResolvedDayWindow[];
  staffBreaks: ResolvedDayWindow[];
  staffAvailableWindows: ResolvedDayWindow[];
  timeOffBlocks: Array<{ startsAt: string; endsAt: string; status: TimeOffStatus }>;
  notes: string[];
}
