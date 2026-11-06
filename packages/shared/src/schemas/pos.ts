import { z } from 'zod';
import {
  PAYMENT_METHOD_KINDS,
  SALE_LINE_KINDS,
  SALE_STATUSES,
} from '../types/pos';

const moneyMinor = z.coerce.number().int().min(0);
const positiveMoneyMinor = z.coerce.number().int().positive();

export const saleLineInputSchema = z
  .object({
    kind: z.enum(SALE_LINE_KINDS),
    sourceServiceId: z.string().uuid().optional().nullable(),
    sourceAddonId: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1).max(160).optional(),
    quantity: z.coerce.number().int().min(1).max(100).optional().default(1),
    unitPriceMinor: moneyMinor.optional(),
    staffMembershipId: z.string().uuid().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'service' && !value.sourceServiceId) {
      ctx.addIssue({
        code: 'custom',
        message: 'sourceServiceId is required for service lines',
        path: ['sourceServiceId'],
      });
    }
    if (value.kind === 'addon' && !value.sourceAddonId) {
      ctx.addIssue({
        code: 'custom',
        message: 'sourceAddonId is required for addon lines',
        path: ['sourceAddonId'],
      });
    }
    if (value.kind === 'custom') {
      if (!value.name?.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: 'name is required for custom lines',
          path: ['name'],
        });
      }
      if (value.unitPriceMinor === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'unitPriceMinor is required for custom lines',
          path: ['unitPriceMinor'],
        });
      }
    }
  });

export const createWalkInSaleSchema = z.object({
  locationId: z.string().uuid(),
  customerId: z.string().uuid().optional().nullable(),
  lines: z.array(saleLineInputSchema).min(1).max(50),
  discountMinor: moneyMinor.optional().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const checkoutBookingSaleSchema = z.object({
  bookingId: z.string().uuid(),
  discountMinor: moneyMinor.optional().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const updateOpenSaleSchema = z.object({
  lines: z.array(saleLineInputSchema).min(1).max(50),
  discountMinor: moneyMinor.optional().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const recordSalePaymentSchema = z.object({
  amountMinor: positiveMoneyMinor,
  methodKind: z.enum(PAYMENT_METHOD_KINDS),
  methodLabel: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const refundSalePaymentSchema = z.object({
  amountMinor: positiveMoneyMinor,
  reason: z.string().trim().min(1).max(500),
  methodKind: z.enum(PAYMENT_METHOD_KINDS).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const voidSaleSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const saleListQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(SALE_STATUSES).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const dailySummaryQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.string().uuid(),
});

export const openRegisterSessionSchema = z.object({
  locationId: z.string().uuid(),
  openingFloatMinor: moneyMinor,
});

export const closeRegisterSessionSchema = z.object({
  countedMinor: moneyMinor,
  discrepancyNote: z.string().trim().max(1000).optional().nullable(),
});

export const registerCashAdjustmentSchema = z.object({
  kind: z.enum(['cash_in', 'cash_out']),
  amountMinor: positiveMoneyMinor,
  note: z.string().trim().min(1).max(500),
});

export const taxSettingsUpdateSchema = z.object({
  taxEnabled: z.boolean(),
  taxName: z.string().trim().min(1).max(80).optional().nullable(),
  rateBps: z.coerce.number().int().min(0).max(100000),
});

export type SaleLineInput = z.input<typeof saleLineInputSchema>;
export type CreateWalkInSaleInput = z.input<typeof createWalkInSaleSchema>;
export type CheckoutBookingSaleInput = z.input<typeof checkoutBookingSaleSchema>;
export type UpdateOpenSaleInput = z.input<typeof updateOpenSaleSchema>;
export type RecordSalePaymentInput = z.input<typeof recordSalePaymentSchema>;
export type RefundSalePaymentInput = z.input<typeof refundSalePaymentSchema>;
export type VoidSaleInput = z.input<typeof voidSaleSchema>;
export type SaleListQuery = z.output<typeof saleListQuerySchema>;
export type DailySummaryQuery = z.output<typeof dailySummaryQuerySchema>;
export type OpenRegisterSessionInput = z.input<typeof openRegisterSessionSchema>;
export type CloseRegisterSessionInput = z.input<typeof closeRegisterSessionSchema>;
export type RegisterCashAdjustmentInput = z.input<typeof registerCashAdjustmentSchema>;
export type TaxSettingsUpdateInput = z.input<typeof taxSettingsUpdateSchema>;
