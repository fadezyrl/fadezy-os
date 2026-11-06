import { z } from 'zod';

export const insightsOverviewQuerySchema = z.object({
  locationId: z.string().uuid(),
  preset: z.enum(['7d', '30d']).optional().default('7d'),
  /** Inclusive local YYYY-MM-DD; when omitted, derived from preset ending today. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type InsightsOverviewQuery = z.output<typeof insightsOverviewQuerySchema>;
