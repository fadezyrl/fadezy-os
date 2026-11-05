import type { BusinessRole } from '../types/business';
import type { SchedulePermissions } from '../types/schedule';

export const SCHEDULE_ACTIONS = [
  'manage_hours',
  'manage_staff_schedules',
  'request_time_off',
  'review_time_off',
  'view_all_schedules',
] as const;

export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

const ROLE_CAPABILITIES: Record<BusinessRole, ReadonlySet<ScheduleAction>> = {
  owner: new Set(SCHEDULE_ACTIONS),
  manager: new Set([
    'manage_hours',
    'manage_staff_schedules',
    'request_time_off',
    'review_time_off',
    'view_all_schedules',
  ]),
  staff: new Set(['request_time_off']),
};

export function canPerformScheduleAction(role: BusinessRole, action: ScheduleAction): boolean {
  return ROLE_CAPABILITIES[role]?.has(action) ?? false;
}

export function resolveSchedulePermissions(role: BusinessRole): SchedulePermissions {
  return {
    canManageHours: canPerformScheduleAction(role, 'manage_hours'),
    canManageStaffSchedules: canPerformScheduleAction(role, 'manage_staff_schedules'),
    canRequestTimeOff: canPerformScheduleAction(role, 'request_time_off'),
    canReviewTimeOff: canPerformScheduleAction(role, 'review_time_off'),
    canViewAllSchedules: canPerformScheduleAction(role, 'view_all_schedules'),
  };
}

/** Minutes helpers shared by clients and API validation. */
export const MINUTES_PER_DAY = 1440;

export function intervalsOverlap(
  a: { startMinute: number; endMinute: number },
  b: { startMinute: number; endMinute: number },
): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

export function formatMinuteOfDay(minute: number): string {
  const normalized = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const dayOffset = Math.floor(minute / MINUTES_PER_DAY);
  const hh = String(Math.floor(normalized / 60)).padStart(2, '0');
  const mm = String(normalized % 60).padStart(2, '0');
  return dayOffset > 0 ? `${hh}:${mm}+${dayOffset}d` : `${hh}:${mm}`;
}
