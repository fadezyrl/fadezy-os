import type {
  LocationHoursMode,
  ScheduleDateException,
  ScheduleExceptionKind,
  StaffTimeOff,
  StaffWeeklyBreak,
  StaffWeeklyInterval,
  StaffWeeklySchedule,
  TimeOffCategory,
  TimeOffStatus,
  TimeInterval,
  WeeklyHourInterval,
  Weekday,
} from '@fadezy/shared';

export function mapWeeklyInterval(row: {
  id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  sort_order: number;
}): WeeklyHourInterval {
  return {
    id: row.id,
    weekday: row.weekday as Weekday,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    sortOrder: row.sort_order,
  };
}

export function mapException(row: {
  id: string;
  business_id: string;
  location_id: string | null;
  exception_date: string;
  kind: ScheduleExceptionKind;
  label: string | null;
  intervals: TimeInterval[] | Array<{ start_minute: number; end_minute: number }> | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}): ScheduleDateException {
  const raw = row.intervals ?? [];
  const intervals: TimeInterval[] = raw.map((item) => {
    if ('startMinute' in item) return item as TimeInterval;
    const snake = item as { start_minute: number; end_minute: number };
    return { startMinute: snake.start_minute, endMinute: snake.end_minute };
  });
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    exceptionDate: row.exception_date,
    kind: row.kind,
    label: row.label,
    intervals,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStaffSchedule(
  row: {
    id: string;
    business_id: string;
    membership_id: string;
    effective_from: string;
    effective_to: string | null;
    superseded_at: string | null;
    label: string | null;
    created_at: string;
    updated_at: string;
  },
  intervals: StaffWeeklyInterval[],
  breaks: StaffWeeklyBreak[],
): StaffWeeklySchedule {
  return {
    id: row.id,
    businessId: row.business_id,
    membershipId: row.membership_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    supersededAt: row.superseded_at,
    label: row.label,
    intervals,
    breaks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStaffInterval(row: {
  id: string;
  weekday: number;
  location_id: string;
  start_minute: number;
  end_minute: number;
  sort_order: number;
}): StaffWeeklyInterval {
  return {
    id: row.id,
    weekday: row.weekday as Weekday,
    locationId: row.location_id,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    sortOrder: row.sort_order,
  };
}

export function mapStaffBreak(row: {
  id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  is_paid: boolean;
  sort_order: number;
}): StaffWeeklyBreak {
  return {
    id: row.id,
    weekday: row.weekday as Weekday,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    isPaid: row.is_paid,
    sortOrder: row.sort_order,
  };
}

export function mapTimeOff(row: {
  id: string;
  business_id: string;
  membership_id: string;
  location_id: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  is_full_day: boolean;
  category: TimeOffCategory;
  reason: string | null;
  status: TimeOffStatus;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}): StaffTimeOff {
  return {
    id: row.id,
    businessId: row.business_id,
    membershipId: row.membership_id,
    locationId: row.location_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    isFullDay: row.is_full_day,
    category: row.category,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requested_by,
    reviewedByUserId: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapHoursMode(value: string): LocationHoursMode {
  return value === 'custom' ? 'custom' : 'inherit';
}
