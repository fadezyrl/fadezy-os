import { z } from 'zod';
import { BOOKING_CHANNELS, BOOKING_STATUSES } from '../types/booking';

export const customerInputSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const customerUpdateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(320).optional().nullable(),
    phone: z.string().trim().max(32).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine(
    (value) =>
      value.fullName !== undefined ||
      value.email !== undefined ||
      value.phone !== undefined ||
      value.notes !== undefined,
    { message: 'Provide at least one field to update' },
  );

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'archived', 'all']).optional().default('active'),
  sort: z.enum(['name', 'created_at']).optional().default('name'),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const customerBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const bookingSlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.string().uuid(),
  serviceId: z.string().uuid(),
  staffMembershipId: z.string().uuid(),
  addonIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((value) => {
      if (!value) return [] as string[];
      return Array.isArray(value) ? value : [value];
    }),
  intervalMinutes: z.coerce.number().int().min(5).max(60).optional(),
});

export const createBookingInputSchema = z.object({
  locationId: z.string().uuid(),
  staffMembershipId: z.string().uuid(),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).max(20).optional().default([]),
  startsAt: z.string().datetime({ offset: true }),
  customerId: z.string().uuid().optional().nullable(),
  customer: customerInputSchema.optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(128),
  channel: z.enum(BOOKING_CHANNELS).optional().default('workspace'),
}).superRefine((value, ctx) => {
  if (!value.customerId && !value.customer) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide customerId or customer details',
      path: ['customer'],
    });
  }
});

export const guestCreateBookingInputSchema = z
  .object({
    businessSlug: z.string().trim().min(2).max(80),
    locationId: z.string().uuid(),
    staffMembershipId: z.string().uuid(),
    serviceId: z.string().uuid(),
    addonIds: z.array(z.string().uuid()).max(20).optional().default([]),
    startsAt: z.string().datetime({ offset: true }),
    customer: customerInputSchema,
    notes: z.string().trim().max(2000).optional().nullable(),
    idempotencyKey: z.string().trim().min(8).max(128),
  });

export const guestSlotsQuerySchema = bookingSlotsQuerySchema.extend({
  businessSlug: z.string().trim().min(2).max(80),
});

export const bookingListQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  locationId: z.string().uuid().optional(),
  staffMembershipId: z.string().uuid().optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const rescheduleBookingInputSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const cancelBookingInputSchema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
});

export type CustomerInput = z.input<typeof customerInputSchema>;
export type CustomerUpdateInput = z.input<typeof customerUpdateSchema>;
export type CustomerListQuery = z.output<typeof customerListQuerySchema>;
export type CustomerBookingsQuery = z.output<typeof customerBookingsQuerySchema>;
export type CreateBookingInput = z.input<typeof createBookingInputSchema>;
export type GuestCreateBookingInput = z.input<typeof guestCreateBookingInputSchema>;
export type BookingSlotsQuery = z.output<typeof bookingSlotsQuerySchema>;
export type BookingListQuery = z.output<typeof bookingListQuerySchema>;
export type RescheduleBookingInput = z.input<typeof rescheduleBookingInputSchema>;
export type CancelBookingInput = z.input<typeof cancelBookingInputSchema>;
