import { z } from 'zod';
import {
  CATALOG_BUFFER_MAX,
  CATALOG_DEFAULT_PAGE_LIMIT,
  CATALOG_DURATION_MAX,
  CATALOG_DURATION_MIN,
  CATALOG_MAX_PAGE_LIMIT,
} from '../constants/catalog';

const isoCurrency = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'Currency must be an ISO 4217 code')
  .transform((value) => value.toUpperCase());

const priceMinorSchema = z
  .number()
  .int('Price must be an integer number of minor units')
  .nonnegative('Price cannot be negative')
  .max(Number.MAX_SAFE_INTEGER, 'Price exceeds supported range');

const durationSchema = z
  .number()
  .int()
  .min(CATALOG_DURATION_MIN, `Duration must be at least ${CATALOG_DURATION_MIN} minute`)
  .max(CATALOG_DURATION_MAX, `Duration cannot exceed ${CATALOG_DURATION_MAX} minutes`);

const bufferSchema = z
  .number()
  .int()
  .min(0)
  .max(CATALOG_BUFFER_MAX)
  .optional()
  .default(0);

const optionalUrl = z
  .union([z.string().url(), z.literal(''), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return null;
    return value;
  });

export const catalogListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional().default('active'),
  locationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_MAX_PAGE_LIMIT).optional().default(CATALOG_DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => {
      if (value === undefined) return false;
      if (typeof value === 'boolean') return value;
      return value === 'true';
    }),
});

export const createServiceCategoryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  imageUrl: optionalUrl,
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateServiceCategoryInputSchema = createServiceCategoryInputSchema
  .partial()
  .extend({
    reassignServicesToCategoryId: z.string().uuid().optional().nullable(),
  });

export const reorderItemsInputSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(500),
});

export const createServiceInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  categoryId: z.string().uuid().optional().nullable(),
  description: z.string().trim().max(5000).optional().nullable(),
  imageUrl: optionalUrl,
  priceMinor: priceMinorSchema,
  /** Optional; server snapshots business default currency. If sent, must match. */
  currency: isoCurrency.optional(),
  durationMinutes: durationSchema,
  processingMinutes: bufferSchema,
  bufferBeforeMinutes: bufferSchema,
  bufferAfterMinutes: bufferSchema,
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional().default(true),
  isBookableOnline: z.boolean().optional().default(true),
  isWalkIn: z.boolean().optional().default(true),
  locationIds: z.array(z.string().uuid()).optional(),
  addonIds: z.array(z.string().uuid()).optional(),
});

export const updateServiceInputSchema = createServiceInputSchema.partial().extend({
  /** Currency changes are not allowed via silent conversion — omit or match existing. */
  currency: isoCurrency.optional(),
});

export const createServiceAddonInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  priceMinor: priceMinorSchema,
  currency: isoCurrency.optional(),
  durationMinutes: z.number().int().min(0).max(CATALOG_DURATION_MAX).optional().default(0),
  isActive: z.boolean().optional().default(true),
  isOptionalDefault: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export const updateServiceAddonInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  priceMinor: priceMinorSchema.optional(),
  currency: isoCurrency.optional(),
  durationMinutes: z.number().int().min(0).max(CATALOG_DURATION_MAX).optional(),
  isActive: z.boolean().optional(),
  isOptionalDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export const upsertServiceLocationSettingsInputSchema = z.object({
  settings: z
    .array(
      z.object({
        locationId: z.string().uuid(),
        isAvailable: z.boolean(),
        priceMinor: priceMinorSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const setServiceAddonsInputSchema = z.object({
  items: z
    .array(
      z.object({
        addonId: z.string().uuid(),
        isOptional: z.boolean().optional().default(true),
        sortOrder: z.number().int().min(0).max(1_000_000).optional().default(0),
      }),
    )
    .max(200),
});

export type CreateServiceCategoryInput = z.input<typeof createServiceCategoryInputSchema>;
export type UpdateServiceCategoryInput = z.input<typeof updateServiceCategoryInputSchema>;
export type CreateServiceInput = z.input<typeof createServiceInputSchema>;
export type UpdateServiceInput = z.input<typeof updateServiceInputSchema>;
export type CreateServiceAddonInput = z.input<typeof createServiceAddonInputSchema>;
export type UpdateServiceAddonInput = z.input<typeof updateServiceAddonInputSchema>;
export type CatalogListQuery = z.output<typeof catalogListQuerySchema>;
export type ReorderItemsInput = z.input<typeof reorderItemsInputSchema>;
export type UpsertServiceLocationSettingsInput = z.input<
  typeof upsertServiceLocationSettingsInputSchema
>;
export type SetServiceAddonsInput = z.input<typeof setServiceAddonsInputSchema>;
