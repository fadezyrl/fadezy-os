import type {
  BusinessPosTaxSettings,
  DailyPosSummary,
  PaymentMethodKind,
  RegisterCashMovement,
  RegisterSession,
  Sale,
  SaleLine,
  SaleLineKind,
  SalePayment,
  SaleRefund,
  SaleSource,
  SaleStatus,
} from '@fadezy/shared';

export function mapTaxSettings(row: {
  business_id: string;
  tax_enabled: boolean;
  tax_name: string | null;
  rate_bps: number;
  updated_at: string;
}): BusinessPosTaxSettings {
  return {
    businessId: row.business_id,
    taxEnabled: row.tax_enabled,
    taxName: row.tax_name,
    rateBps: row.rate_bps,
    updatedAt: row.updated_at,
  };
}

export function mapSaleLine(row: {
  id: string;
  sale_id: string;
  kind: SaleLineKind;
  source_service_id: string | null;
  source_addon_id: string | null;
  name: string;
  quantity: number;
  unit_price_minor: number | string;
  line_subtotal_minor: number | string;
  allocated_discount_minor: number | string;
  taxable_minor: number | string;
  tax_minor: number | string;
  line_total_minor: number | string;
  currency: string;
  sort_order: number;
  staff_membership_id: string | null;
  created_at: string;
}): SaleLine {
  return {
    id: row.id,
    saleId: row.sale_id,
    kind: row.kind,
    sourceServiceId: row.source_service_id,
    sourceAddonId: row.source_addon_id,
    name: row.name,
    quantity: row.quantity,
    unitPriceMinor: Number(row.unit_price_minor),
    lineSubtotalMinor: Number(row.line_subtotal_minor),
    allocatedDiscountMinor: Number(row.allocated_discount_minor),
    taxableMinor: Number(row.taxable_minor),
    taxMinor: Number(row.tax_minor),
    lineTotalMinor: Number(row.line_total_minor),
    currency: row.currency,
    sortOrder: row.sort_order,
    staffMembershipId: row.staff_membership_id,
    createdAt: row.created_at,
  };
}

export function mapPayment(
  row: {
    id: string;
    sale_id: string;
    business_id: string;
    amount_minor: number | string;
    currency: string;
    method_kind: PaymentMethodKind;
    method_label: string | null;
    register_session_id: string | null;
    recorded_by_user_id: string | null;
    recorded_at: string;
    notes: string | null;
    created_at: string;
  },
  refundedMinor = 0,
): SalePayment {
  return {
    id: row.id,
    saleId: row.sale_id,
    businessId: row.business_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    methodKind: row.method_kind,
    methodLabel: row.method_label,
    registerSessionId: row.register_session_id,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at,
    notes: row.notes,
    refundedMinor,
    createdAt: row.created_at,
  };
}

export function mapRefund(row: {
  id: string;
  sale_id: string;
  payment_id: string;
  business_id: string;
  amount_minor: number | string;
  currency: string;
  reason: string;
  register_session_id: string | null;
  recorded_by_user_id: string | null;
  recorded_at: string;
  created_at: string;
}): SaleRefund {
  return {
    id: row.id,
    saleId: row.sale_id,
    paymentId: row.payment_id,
    businessId: row.business_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    reason: row.reason,
    registerSessionId: row.register_session_id,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  };
}

export function mapSale(
  row: {
    id: string;
    business_id: string;
    location_id: string;
    location_name: string;
    booking_id: string | null;
    customer_id: string | null;
    customer_name: string | null;
    status: SaleStatus;
    source: SaleSource;
    currency: string;
    subtotal_minor: number | string;
    discount_minor: number | string;
    tax_minor: number | string;
    total_minor: number | string;
    amount_paid_minor: number | string;
    amount_refunded_minor: number | string;
    tax_enabled: boolean;
    tax_name: string | null;
    tax_rate_bps: number;
    reference_code: string;
    notes: string | null;
    void_reason: string | null;
    voided_at: string | null;
    voided_by_user_id: string | null;
    created_by_user_id: string | null;
    created_at: string;
    updated_at: string;
  },
  lines: SaleLine[],
  payments: SalePayment[],
  refunds: SaleRefund[],
): Sale {
  const total = Number(row.total_minor);
  const paid = Number(row.amount_paid_minor);
  const refunded = Number(row.amount_refunded_minor);
  const netPaid = paid - refunded;
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: row.location_name,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    source: row.source,
    currency: row.currency,
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    taxMinor: Number(row.tax_minor),
    totalMinor: total,
    amountPaidMinor: paid,
    amountRefundedMinor: refunded,
    netPaidMinor: netPaid,
    balanceDueMinor: total - netPaid,
    taxEnabled: row.tax_enabled,
    taxName: row.tax_name,
    taxRateBps: row.tax_rate_bps,
    referenceCode: row.reference_code,
    notes: row.notes,
    voidReason: row.void_reason,
    voidedAt: row.voided_at,
    voidedByUserId: row.voided_by_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    payments,
    refunds,
  };
}

export function mapRegisterSession(row: {
  id: string;
  business_id: string;
  location_id: string;
  status: 'open' | 'closed';
  opening_float_minor: number | string;
  opened_by_user_id: string | null;
  opened_at: string;
  closed_by_user_id: string | null;
  closed_at: string | null;
  expected_minor: number | string | null;
  counted_minor: number | string | null;
  discrepancy_minor: number | string | null;
  discrepancy_note: string | null;
  created_at: string;
  updated_at: string;
}, movements?: RegisterCashMovement[]): RegisterSession {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    status: row.status,
    openingFloatMinor: Number(row.opening_float_minor),
    openedByUserId: row.opened_by_user_id,
    openedAt: row.opened_at,
    closedByUserId: row.closed_by_user_id,
    closedAt: row.closed_at,
    expectedMinor: row.expected_minor == null ? null : Number(row.expected_minor),
    countedMinor: row.counted_minor == null ? null : Number(row.counted_minor),
    discrepancyMinor: row.discrepancy_minor == null ? null : Number(row.discrepancy_minor),
    discrepancyNote: row.discrepancy_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    movements,
  };
}

export function mapCashMovement(row: {
  id: string;
  session_id: string;
  kind: RegisterCashMovement['kind'];
  amount_minor: number | string;
  note: string | null;
  sale_payment_id: string | null;
  sale_refund_id: string | null;
  actor_user_id: string | null;
  created_at: string;
}): RegisterCashMovement {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    amountMinor: Number(row.amount_minor),
    note: row.note,
    salePaymentId: row.sale_payment_id,
    saleRefundId: row.sale_refund_id,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

export function mapDailySummary(input: {
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
}): DailyPosSummary {
  return input;
}
