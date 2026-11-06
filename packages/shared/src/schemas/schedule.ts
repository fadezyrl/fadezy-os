import { z } from 'zod';
import { MINUTES_PER_DAY, intervalsOverlap } from '../constants/schedule';
import {
  SCHEDULE_EXCEPTION_KINDS,
  TIME_OFF_CATEGORIES,
  WEEKDAYS,
} from '../types/schedule';

const weekdaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

export const timeIntervalInputSchema = z
  .object({
    startMinute: z.number().int().min(0).max(MINUTES_PER_DAY - 1),
    endMinute: z.number().int().min(1).max(MINUTES_PER_DAY * 2),
  })
  .superRefine((value, ctx) => {
    if (value.endMinute <= value.startMinute) {
      ctx.addIssue({
        code: 'custom',
        message: 'endMinute must be greater than startMinute (use values > 1440 for overnight)',
        path: ['endMinute'],
      });
    }
    if (value.endMinute - value.startMinute > MINUTES_PER_DAY) {
      ctx.addIssue({
        code: 'custom',
        message: 'Interval length cannot exceed 24 hours',
        path: ['endMinute'],
      });
    }
  });

export const weeklyIntervalInputSchema = timeIntervalInputSchema.and(
  z.object({
    weekday: weekdaySchema,
    sortOrder: z.number().int().min(0).max(100).optional().default(0),
  }),
);

function refineNoOverlaps(
  intervals: Array<{ weekday?: number; startMinute: number; endMinute: number }>,
  ctx: z.RefinementCtx,
  groupKey: (item: { weekday?: number }) => string,
) {
  const byGroup = new Map<string, Array<{ startMinute: number; endMinute: number; index: number }>>();
  intervals.forEach((item, index) => {
    const key = groupKey(item);
    const list = byGroup.get(key) ?? [];
    list.push({ startMinute: item.startMinute, endMinute: item.endMinute, index });
    byGroup.set(key, list);
  });
  for (const [, list] of byGroup) {
    for (let i = 0; i < list.length; i += 1) {
      const left = list[i];
      if (!left) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const right = list[j];
        if (!right) continue;
        if (intervalsOverlap(left, right)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Overlapping intervals are not allowed',
            path: [right.index],
          });
        }
      }
    }
  }
}

export const putWeeklyHoursInputSchema = z
  .object({
    intervals: z.array(weeklyIntervalInputSchema).max(70),
  })
  .superRefine((value, ctx) => {
    refineNoOverlaps(value.intervals, ctx, (item) => String(item.weekday));
  });

export const putLocationHoursInputSchema = z
  .object({
    hoursMode: z.enum(['inherit', 'custom']),
    intervals: z.array(weeklyIntervalInputSchema).max(70).optional().default([]),
  })
  .superRefine((value, ctx) => {
    if (value.hoursMode === 'custom') {
      refineNoOverlaps(value.intervals, ctx, (item) => String(item.weekday));
    }
  });

export const scheduleExceptionInputSchema = z
  .object({
    locationId: z.string().uuid().nullable().optional(),
    exceptionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(SCHEDULE_EXCEPTION_KINDS),
    label: z.string().trim().max(120).optional().nullable(),
    intervals: z.array(timeIntervalInputSchema).max(10).optional().default([]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'closed' && value.intervals.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Closed exceptions cannot include intervals',
        path: ['intervals'],
      });
    }
    if (value.kind === 'special_hours' && value.intervals.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Special hours require at least one interval',
        path: ['intervals'],
      });
    }
    refineNoOverlaps(value.intervals, ctx, () => 'day');
  });

export const staffScheduleIntervalInputSchema = weeklyIntervalInputSchema.and(
  z.object({
    locationId: z.string().uuid(),
  }),
);

export const staffBreakInputSchema = timeIntervalInputSchema.and(
  z.object({
    weekday: weekdaySchema,
    isPaid: z.boolean().optional().default(false),
    sortOrder: z.number().int().min(0).max(100).optional().default(0),
  }),
);

export const putStaffScheduleInputSchema = z
  .object({
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().trim().max(120).optional().nullable(),
    intervals: z.array(staffScheduleIntervalInputSchema).max(70),
    breaks: z.array(staffBreakInputSchema).max(70).optional().default([]),
  })
  .superRefine((value, ctx) => {
    refineNoOverlaps(value.intervals, ctx, (item) => `${item.weekday}:${(item as { locationId: string }).locationId}`);
    refineNoOverlaps(value.breaks, ctx, (item) => String(item.weekday));

    for (let i = 0; i < value.breaks.length; i += 1) {
      const brk = value.breaks[i];
      if (!brk) continue;
      const dayIntervals = value.intervals.filter((item) => item.weekday === brk.weekday);
      const inside = dayIntervals.some(
        (interval) =>
          brk.startMinute >= interval.startMinute && brk.endMinute <= interval.endMinute,
      );
      if (!inside) {
        ctx.addIssue({
          code: 'custom',
          message: 'Break must fall within a working interval on the same weekday',
          path: ['breaks', i],
        });
      }
    }
  });

export const createTimeOffInputSchema = z.object({
  membershipId: z.string().uuid().optional(),
  locationId: z.string().uuid().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinute: z.number().int().min(0).max(MINUTES_PER_DAY - 1).optional(),
  endMinute: z.number().int().min(1).max(MINUTES_PER_DAY).optional(),
  isFullDay: z.boolean().optional().default(true),
  category: z.enum(TIME_OFF_CATEGORIES),
  reason: z.string().trim().max(500).optional().nullable(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const availabilityContextQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.string().uuid(),
  membershipId: z.string().uuid().optional(),
});

export type PutWeeklyHoursInput = z.input<typeof putWeeklyHoursInputSchema>;
export type PutLocationHoursInput = z.input<typeof putLocationHoursInputSchema>;
export type ScheduleExceptionInput = z.input<typeof scheduleExceptionInputSchema>;
export type PutStaffScheduleInput = z.input<typeof putStaffScheduleInputSchema>;
export type CreateTimeOffInput = z.input<typeof createTimeOffInputSchema>;
export type AvailabilityContextQuery = z.output<typeof availabilityContextQuerySchema>;

export { WEEKDAYS };
