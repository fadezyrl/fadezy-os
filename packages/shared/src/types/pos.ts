export const SALE_STATUSES = [
  'open',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const SALE_SOURCES = ['walk_in', 'booking'] as const;
export type SaleSource = (typeof SALE_SOURCES)[number];

export const SALE_LINE_KINDS = ['service', 'addon', 'custom'] as const;
export type SaleLineKind = (typeof SALE_LINE_KINDS)[number];

export const PAYMENT_METHOD_KINDS = ['cash', 'card_manual', 'other'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export const REGISTER_SESSION_STATUSES = ['open', 'closed'] as const;
export type RegisterSessionStatus = (typeof REGISTER_SESSION_STATUSES)[number];

export const CASH_MOVEMENT_KINDS = [
  'open_float',
  'cash_payment',
  'cash_refund',
  'cash_in',
  'cash_out',
  'close_count',
] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export interface PosPermissions {
  canCreateSales: boolean;
  canManageAllLocations: boolean;
  canManageAssignedLocations: boolean;
  canApplyDiscount: boolean;
  canCreateCustomLines: boolean;
  canRecordPayments: boolean;
  canRefund: boolean;
  canVoid: boolean;
  canEditOpenSale: boolean;
  canManageTaxSettings: boolean;
  canOpenCloseRegister: boolean;
  canAdjustCash: boolean;
  canViewReports: boolean;
}

export interface BusinessPosTaxSettings {
  businessId: string;
  taxEnabled: boolean;
  taxName: string | null;
  rateBps: number;
  updatedAt: string;
}

export interface SaleLine {
  id: string;
  saleId: string;
  kind: SaleLineKind;
  sourceServiceId: string | null;
  sourceAddonId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  allocatedDiscountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
  currency: string;
  sortOrder: number;
  staffMembershipId: string | null;
  createdAt: string;
}

export interface SalePayment {
  id: string;
  saleId: string;
  businessId: string;
  amountMinor: number;
  currency: string;
  methodKind: PaymentMethodKind;
  methodLabel: string | null;
  registerSessionId: string | null;
  recordedByUserId: string | null;
  recordedAt: string;
  notes: string | null;
  refundedMinor: number;
  createdAt: string;
}

export interface SaleRefund {
  id: string;
  saleId: string;
  paymentId: string;
  businessId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  registerSessionId: string | null;
  recordedByUserId: string | null;
  recordedAt: string;
  createdAt: string;
}

export interface SaleEvent {
  id: string;
  saleId: string;
  eventType: string;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface Sale {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  bookingId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: SaleStatus;
  source: SaleSource;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  netPaidMinor: number;
  balanceDueMinor: number;
  taxEnabled: boolean;
  taxName: string | null;
  taxRateBps: number;
  referenceCode: string;
  notes: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SaleLine[];
  payments: SalePayment[];
  refunds: SaleRefund[];
}

export interface SaleListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface PaginatedSales {
  items: Sale[];
  meta: SaleListMeta;
}

export interface RegisterCashMovement {
  id: string;
  sessionId: string;
  kind: CashMovementKind;
  amountMinor: number;
  note: string | null;
  salePaymentId: string | null;
  saleRefundId: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface RegisterSession {
  id: string;
  businessId: string;
  locationId: string;
  status: RegisterSessionStatus;
  openingFloatMinor: number;
  openedByUserId: string | null;
  openedAt: string;
  closedByUserId: string | null;
  closedAt: string | null;
  expectedMinor: number | null;
  countedMinor: number | null;
  discrepancyMinor: number | null;
  discrepancyNote: string | null;
  createdAt: string;
  updatedAt: string;
  movements?: RegisterCashMovement[];
}

export interface DailyPosSummary {
  date: string;
  locationId: string;
  timezone: string;
  currency: string;
  saleCount: number;
  grossSalesMinor: number;
  discountMinor: number;
  taxMinor: number;
  netCollectedMinor: number;
  refundedMinor: number;
  voidedCount: number;
}
