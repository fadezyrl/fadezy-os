import { z } from 'zod';
import { EMPLOYMENT_TYPES, INVITABLE_ROLES } from '../types/team';

const optionalUrl = z
  .union([z.string().url(), z.literal(''), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return null;
    return value;
  });

export const createInvitationInputSchema = z.object({
  email: z.string().trim().email().max(320).transform((v) => v.toLowerCase()),
  role: z.enum(INVITABLE_ROLES),
  displayName: z.string().trim().min(1).max(120).optional().nullable(),
  locationIds: z.array(z.string().uuid()).max(50).optional().default([]),
});

export const acceptInvitationInputSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export const updateStaffProfileInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  imageUrl: optionalUrl,
  phone: z.string().trim().max(32).optional().nullable(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional().nullable(),
  bio: z.string().trim().max(2000).optional().nullable(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  internalNotes: z.string().trim().max(4000).optional().nullable(),
});

export const updateMemberRoleInputSchema = z.object({
  role: z.enum(['manager', 'staff']),
});

export const updateMemberStatusInputSchema = z.object({
  action: z.enum(['suspend', 'reactivate', 'deactivate']),
});

export const setMemberLocationsInputSchema = z.object({
  locationIds: z.array(z.string().uuid()).max(50),
});

export const setMemberServicesInputSchema = z.object({
  serviceIds: z.array(z.string().uuid()).max(200),
});

export const teamListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  role: z.enum(['owner', 'manager', 'staff']).optional(),
  locationId: z.string().uuid().optional(),
  status: z.enum(['active', 'suspended', 'all']).optional().default('active'),
});

export type CreateInvitationInput = z.input<typeof createInvitationInputSchema>;
export type AcceptInvitationInput = z.input<typeof acceptInvitationInputSchema>;
export type UpdateStaffProfileInput = z.input<typeof updateStaffProfileInputSchema>;
export type UpdateMemberRoleInput = z.input<typeof updateMemberRoleInputSchema>;
export type UpdateMemberStatusInput = z.input<typeof updateMemberStatusInputSchema>;
export type SetMemberLocationsInput = z.input<typeof setMemberLocationsInputSchema>;
export type SetMemberServicesInput = z.input<typeof setMemberServicesInputSchema>;
export type TeamListQuery = z.output<typeof teamListQuerySchema>;
