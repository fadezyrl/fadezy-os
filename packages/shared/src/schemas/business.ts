import { z } from 'zod';
import {
  BUSINESS_ROLES,
  BUSINESS_TYPES,
  LOCATION_TYPES,
  ONBOARDING_STATUSES,
} from '../types/business';

const countryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'Country must be an ISO 3166-1 alpha-2 code');

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code');

const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Timezone is required')
  .max(64, 'Timezone is too long');

const localeSchema = z
  .string()
  .trim()
  .min(2, 'Locale is required')
  .max(35, 'Locale is too long');

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may contain lowercase letters, numbers, and hyphens')
  .min(2, 'Slug is too short')
  .max(64, 'Slug is too long');

const optionalEmail = z
  .union([z.string().trim().email().max(320), z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const optionalUrl = z
  .union([z.string().trim().url().max(2048), z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const optionalPhone = z
  .union([
    z
      .string()
      .trim()
      .max(32)
      .regex(/^\+?[0-9\s()-]{6,32}$/, 'Enter a valid international phone number'),
    z.literal(''),
    z.null(),
  ])
  .optional()
  .transform((value) => (value ? value : null));

export const businessLocationInputSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(120),
  locationType: z.enum(LOCATION_TYPES).default('salon'),
  addressLine1: z.string().trim().max(180).optional().nullable(),
  addressLine2: z.string().trim().max(180).optional().nullable(),
  city: z.string().trim().min(1, 'City is required').max(120),
  stateRegion: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(32).optional().nullable(),
  countryCode: countryCodeSchema,
  phone: optionalPhone,
  email: optionalEmail,
  timezone: timezoneSchema,
  isPrimary: z.boolean().default(true),
});

export const createBusinessInputSchema = z.object({
  name: z.string().trim().min(2, 'Business name is required').max(120),
  slug: slugSchema,
  businessType: z.enum(BUSINESS_TYPES),
  legalName: z.string().trim().max(160).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  email: optionalEmail,
  phone: optionalPhone,
  websiteUrl: optionalUrl,
  countryCode: countryCodeSchema,
  defaultCurrency: currencyCodeSchema,
  timezone: timezoneSchema,
  defaultLocale: localeSchema,
  clientRequestId: z.string().uuid().optional(),
  primaryLocation: businessLocationInputSchema,
});

export const updateBusinessInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().max(160).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    email: optionalEmail,
    phone: optionalPhone,
    websiteUrl: optionalUrl,
    logoUrl: z.union([z.string().url().max(2048), z.literal(''), z.null()]).optional(),
    countryCode: countryCodeSchema.optional(),
    defaultCurrency: currencyCodeSchema.optional(),
    timezone: timezoneSchema.optional(),
    defaultLocale: localeSchema.optional(),
    onboardingStatus: z.enum(ONBOARDING_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export const createLocationInputSchema = businessLocationInputSchema;

export const onboardingDraftSchema = z.object({
  draft: z.record(z.string(), z.unknown()),
});

export const businessRoleSchema = z.enum(BUSINESS_ROLES);

export type CreateBusinessInput = z.infer<typeof createBusinessInputSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessInputSchema>;
export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;
export type OnboardingDraftInput = z.infer<typeof onboardingDraftSchema>;
