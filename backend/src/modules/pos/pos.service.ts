import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  API_ERROR_CODES,
  resolvePosPermissions,
  type BusinessPosTaxSettings,
  type BusinessRole,
  type CheckoutBookingSaleInput,
  type CloseRegisterSessionInput,
  type CreateWalkInSaleInput,
  type DailyPosSummary,
  type OpenRegisterSessionInput,
  type PaginatedSales,
  type PosPermissions,
  type RecordSalePaymentInput,
  type RefundSalePaymentInput,
  type RegisterCashAdjustmentInput,
  type RegisterSession,
  type Sale,
  type SaleListQuery,
  type TaxSettingsUpdateInput,
  type UpdateOpenSaleInput,
  type VoidSaleInput,
} from '@fadezy/shared';
import { localDayUtcBounds } from '../schedule/availability';
import {
  mapCashMovement,
  mapDailySummary,
  mapPayment,
  mapRefund,
  mapRegisterSession,
  mapSale,
  mapSaleLine,
  mapTaxSettings,
} from './pos.mappers';

export class PosServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PosServiceError';
  }
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function mapError(error: unknown): never {
  if (error instanceof PosServiceError) throw error;
  const extended = (error ?? {}) as {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  };
  const haystack = `${extended.message ?? ''} ${extended.code ?? ''} ${extended.details ?? ''} ${extended.hint ?? ''}`.toLowerCase();

  if (haystack.includes('register_required')) {
    throw new PosServiceError('Open cash register required', API_ERROR_CODES.REGISTER_REQUIRED, 422);
  }
  if (haystack.includes('register_already_open')) {
    throw new PosServiceError('Register already open', API_ERROR_CODES.REGISTER_ALREADY_OPEN, 409);
  }
  if (haystack.includes('refund_exceeds_paid')) {
    throw new PosServiceError(
      'Refund exceeds remaining payment balance',
      API_ERROR_CODES.REFUND_EXCEEDS_PAID,
      422,
    );
  }
  if (haystack.includes('sale_conflict') || (haystack.includes('23505') && haystack.includes('booking'))) {
    throw new PosServiceError('An active sale already exists for this booking', API_ERROR_CODES.SALE_CONFLICT, 409);
  }
  if (haystack.includes('payment_invalid')) {
    throw new PosServiceError(
      extended.message || 'Invalid payment',
      API_ERROR_CODES.PAYMENT_INVALID,
      422,
    );
  }
  if (
    haystack.includes('sale_not_editable') ||
    haystack.includes('sale_not_voidable') ||
    haystack.includes('sale_voided') ||
    haystack.includes('booking_not_checkoutable') ||
    haystack.includes('currency_mismatch') ||
    haystack.includes('22023') ||
    haystack.includes('validation_error')
  ) {
    throw new PosServiceError(
      extended.message || 'Validation failed',
      API_ERROR_CODES.VALIDATION_ERROR,
      422,
    );
  }
  if (haystack.includes('idempotency_conflict') || haystack.includes('23505')) {
    throw new PosServiceError('Conflict', API_ERROR_CODES.CONFLICT, 409);
  }
  if (haystack.includes('42501') || haystack.includes('forbidden')) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  if (haystack.includes('not_found') || haystack.includes('p0002')) {
    throw new PosServiceError('Resource not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  throw new PosServiceError(
    extended.message || 'POS operation failed',
    API_ERROR_CODES.INTERNAL_ERROR,
    500,
  );
}

async function getCaller(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<{ role: BusinessRole; membershipId: string; locationIds: string[] }> {
  const { data, error } = await client
    .from('business_members')
    .select('id, role, membership_status, deactivated_at')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) mapError(error);
  if (!data || data.membership_status !== 'active' || data.deactivated_at) {
    throw new PosServiceError('Business not found or not permitted', API_ERROR_CODES.NOT_FOUND, 404);
  }
  const { data: assignments } = await client
    .from('staff_location_assignments')
    .select('location_id')
    .eq('membership_id', data.id);
  return {
    role: data.role as BusinessRole,
    membershipId: data.id,
    locationIds: (assignments ?? []).map((row) => row.location_id),
  };
}

async function loadSaleBundle(client: SupabaseClient, saleId: string): Promise<Sale | null> {
  const { data: sale, error } = await client.from('sales').select('*').eq('id', saleId).maybeSingle();
  if (error) mapError(error);
  if (!sale) return null;
  const [{ data: lines }, { data: payments }, { data: refunds }] = await Promise.all([
    client.from('sale_lines').select('*').eq('sale_id', saleId).order('sort_order'),
    client.from('sale_payments').select('*').eq('sale_id', saleId).order('recorded_at'),
    client.from('sale_refunds').select('*').eq('sale_id', saleId).order('recorded_at'),
  ]);
  const refundRows = refunds ?? [];
  const refundedByPayment = new Map<string, number>();
  for (const row of refundRows) {
    refundedByPayment.set(
      row.payment_id,
      (refundedByPayment.get(row.payment_id) ?? 0) + Number(row.amount_minor),
    );
  }
  return mapSale(
    sale,
    (lines ?? []).map(mapSaleLine),
    (payments ?? []).map((row) => mapPayment(row, refundedByPayment.get(row.id) ?? 0)),
    refundRows.map(mapRefund),
  );
}

function linesForRpc(lines: CreateWalkInSaleInput['lines'] | UpdateOpenSaleInput['lines']) {
  return (lines ?? []).map((line) => ({
    kind: line.kind,
    sourceServiceId: line.sourceServiceId ?? null,
    sourceAddonId: line.sourceAddonId ?? null,
    name: line.name ?? null,
    quantity: line.quantity ?? 1,
    unitPriceMinor: line.unitPriceMinor ?? null,
    staffMembershipId: line.staffMembershipId ?? null,
  }));
}

export async function getPosPermissions(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<PosPermissions> {
  const caller = await getCaller(client, businessId, userId);
  return resolvePosPermissions(caller.role);
}

export async function getTaxSettings(
  client: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<BusinessPosTaxSettings> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('business_pos_tax_settings')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) mapError(error);
  if (!data) {
    return {
      businessId,
      taxEnabled: false,
      taxName: null,
      rateBps: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return mapTaxSettings(data);
}

export async function updateTaxSettings(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: TaxSettingsUpdateInput,
): Promise<BusinessPosTaxSettings> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolvePosPermissions(caller.role);
  if (!permissions.canManageTaxSettings) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client
    .from('business_pos_tax_settings')
    .upsert(
      {
        business_id: businessId,
        tax_enabled: input.taxEnabled,
        tax_name: input.taxName ?? null,
        rate_bps: input.rateBps,
      },
      { onConflict: 'business_id' },
    )
    .select('*')
    .single();
  if (error) mapError(error);
  return mapTaxSettings(data);
}

export async function createWalkInSale(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CreateWalkInSaleInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolvePosPermissions(caller.role);
  if (!permissions.canCreateSales) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const walkInDiscount = Number(input.discountMinor ?? 0);
  if (walkInDiscount > 0 && !permissions.canApplyDiscount) {
    throw new PosServiceError('Not permitted to apply discounts', API_ERROR_CODES.FORBIDDEN, 403);
  }
  if (input.lines.some((line) => line.kind === 'custom') && !permissions.canCreateCustomLines) {
    throw new PosServiceError('Not permitted to create custom lines', API_ERROR_CODES.FORBIDDEN, 403);
  }

  const payloadHash = hashPayload({
    locationId: input.locationId,
    customerId: input.customerId ?? null,
    lines: linesForRpc(input.lines),
    discountMinor: walkInDiscount,
    notes: input.notes ?? null,
  });

  const { data, error } = await client.rpc('create_walk_in_sale', {
    p_business_id: businessId,
    p_location_id: input.locationId,
    p_customer_id: input.customerId ?? null,
    p_lines: linesForRpc(input.lines),
    p_discount_minor: walkInDiscount,
    p_notes: input.notes ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_idempotency_payload_hash: payloadHash,
  });
  if (error) mapError(error);
  const saleId = (data as { id?: string })?.id;
  if (!saleId) throw new PosServiceError('Sale create failed', API_ERROR_CODES.INTERNAL_ERROR, 500);
  const sale = await loadSaleBundle(client, saleId);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function checkoutBookingSale(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CheckoutBookingSaleInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolvePosPermissions(caller.role);
  if (!permissions.canCreateSales) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const checkoutDiscount = Number(input.discountMinor ?? 0);
  if (checkoutDiscount > 0 && !permissions.canApplyDiscount) {
    throw new PosServiceError('Not permitted to apply discounts', API_ERROR_CODES.FORBIDDEN, 403);
  }

  const payloadHash = hashPayload({
    bookingId: input.bookingId,
    discountMinor: checkoutDiscount,
    notes: input.notes ?? null,
  });

  const { data, error } = await client.rpc('checkout_booking_to_sale', {
    p_business_id: businessId,
    p_booking_id: input.bookingId,
    p_discount_minor: checkoutDiscount,
    p_notes: input.notes ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_idempotency_payload_hash: payloadHash,
  });
  if (error) mapError(error);
  const saleId = (data as { id?: string })?.id;
  if (!saleId) throw new PosServiceError('Checkout failed', API_ERROR_CODES.INTERNAL_ERROR, 500);
  const sale = await loadSaleBundle(client, saleId);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function updateOpenSale(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  saleId: string,
  input: UpdateOpenSaleInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolvePosPermissions(caller.role);
  if (!permissions.canEditOpenSale) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }

  const { data, error } = await client.rpc('update_open_sale', {
    p_business_id: businessId,
    p_sale_id: saleId,
    p_lines: linesForRpc(input.lines),
    p_discount_minor: input.discountMinor ?? 0,
    p_notes: input.notes ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_idempotency_payload_hash: input.idempotencyKey
      ? hashPayload({
          saleId,
          lines: linesForRpc(input.lines),
          discountMinor: input.discountMinor ?? 0,
          notes: input.notes ?? null,
        })
      : null,
  });
  if (error) mapError(error);
  const id = (data as { id?: string })?.id ?? saleId;
  const sale = await loadSaleBundle(client, id);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function getSale(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  saleId: string,
): Promise<Sale> {
  await getCaller(client, businessId, userId);
  const sale = await loadSaleBundle(client, saleId);
  if (!sale || sale.businessId !== businessId) {
    throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return sale;
}

export async function getSaleByBooking(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  bookingId: string,
): Promise<Sale | null> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('sales')
    .select('id')
    .eq('business_id', businessId)
    .eq('booking_id', bookingId)
    .neq('status', 'voided')
    .maybeSingle();
  if (error) mapError(error);
  if (!data) return null;
  return loadSaleBundle(client, data.id);
}

export async function listSales(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: SaleListQuery,
): Promise<PaginatedSales> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolvePosPermissions(caller.role);
  if (!permissions.canViewReports && !permissions.canCreateSales) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }

  let builder = client
    .from('sales')
    .select('id', { count: 'exact' })
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);

  if (!permissions.canManageAllLocations) {
    if (!caller.locationIds.length) {
      return { items: [], meta: { total: 0, limit: query.limit, offset: query.offset } };
    }
    builder = builder.in('location_id', caller.locationIds);
  }
  if (query.locationId) builder = builder.eq('location_id', query.locationId);
  if (query.customerId) builder = builder.eq('customer_id', query.customerId);
  if (query.status) builder = builder.eq('status', query.status);
  if (query.from) builder = builder.gte('created_at', query.from);
  if (query.to) builder = builder.lt('created_at', query.to);

  if (query.date) {
    if (!query.locationId) {
      throw new PosServiceError(
        'locationId is required when filtering by date',
        API_ERROR_CODES.VALIDATION_ERROR,
        422,
      );
    }
    const { data: location, error: locError } = await client
      .from('business_locations')
      .select('timezone')
      .eq('id', query.locationId)
      .eq('business_id', businessId)
      .maybeSingle();
    if (locError) mapError(locError);
    if (!location?.timezone) {
      throw new PosServiceError('Location not found', API_ERROR_CODES.NOT_FOUND, 404);
    }
    const bounds = localDayUtcBounds(query.date, location.timezone);
    builder = builder
      .gte('created_at', bounds.startUtc.toISO()!)
      .lt('created_at', bounds.endUtc.toISO()!);
  }

  const { data, error, count } = await builder;
  if (error) mapError(error);
  const ids = (data ?? []).map((row) => row.id);
  const items: Sale[] = [];
  for (const id of ids) {
    const sale = await loadSaleBundle(client, id);
    if (sale) items.push(sale);
  }
  return {
    items,
    meta: { total: count ?? 0, limit: query.limit, offset: query.offset },
  };
}

export async function recordPayment(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  saleId: string,
  input: RecordSalePaymentInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canRecordPayments) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client.rpc('record_sale_payment', {
    p_business_id: businessId,
    p_sale_id: saleId,
    p_amount_minor: input.amountMinor,
    p_method_kind: input.methodKind,
    p_method_label: input.methodLabel ?? null,
    p_notes: input.notes ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_idempotency_payload_hash: hashPayload({
      saleId,
      amountMinor: input.amountMinor,
      methodKind: input.methodKind,
      methodLabel: input.methodLabel ?? null,
    }),
  });
  if (error) mapError(error);
  const id = (data as { id?: string })?.id ?? saleId;
  const sale = await loadSaleBundle(client, id);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function refundPayment(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  saleId: string,
  paymentId: string,
  input: RefundSalePaymentInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canRefund) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client.rpc('refund_sale_payment', {
    p_business_id: businessId,
    p_sale_id: saleId,
    p_payment_id: paymentId,
    p_amount_minor: input.amountMinor,
    p_reason: input.reason,
    p_method_kind: input.methodKind ?? null,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) mapError(error);
  const id = (data as { id?: string })?.id ?? saleId;
  const sale = await loadSaleBundle(client, id);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function voidSale(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  saleId: string,
  input: VoidSaleInput,
): Promise<Sale> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canVoid) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client.rpc('void_sale', {
    p_business_id: businessId,
    p_sale_id: saleId,
    p_reason: input.reason,
  });
  if (error) mapError(error);
  const id = (data as { id?: string })?.id ?? saleId;
  const sale = await loadSaleBundle(client, id);
  if (!sale) throw new PosServiceError('Sale not found', API_ERROR_CODES.NOT_FOUND, 404);
  return sale;
}

export async function openRegister(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: OpenRegisterSessionInput,
): Promise<RegisterSession> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canOpenCloseRegister) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client.rpc('open_register_session', {
    p_business_id: businessId,
    p_location_id: input.locationId,
    p_opening_float_minor: input.openingFloatMinor,
  });
  if (error) mapError(error);
  return mapRegisterSession(data as never);
}

export async function closeRegister(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  sessionId: string,
  input: CloseRegisterSessionInput,
): Promise<RegisterSession> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canOpenCloseRegister) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data, error } = await client.rpc('close_register_session', {
    p_business_id: businessId,
    p_session_id: sessionId,
    p_counted_minor: input.countedMinor,
    p_discrepancy_note: input.discrepancyNote ?? null,
  });
  if (error) mapError(error);
  return mapRegisterSession(data as never);
}

export async function adjustRegisterCash(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  sessionId: string,
  input: RegisterCashAdjustmentInput,
): Promise<RegisterSession> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canAdjustCash) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { error } = await client.rpc('post_register_cash_adjustment', {
    p_business_id: businessId,
    p_session_id: sessionId,
    p_kind: input.kind,
    p_amount_minor: input.amountMinor,
    p_note: input.note,
  });
  if (error) mapError(error);
  return getRegisterSession(client, businessId, userId, sessionId);
}

export async function getRegisterSession(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  sessionId: string,
): Promise<RegisterSession> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('register_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) mapError(error);
  if (!data) throw new PosServiceError('Register session not found', API_ERROR_CODES.NOT_FOUND, 404);
  const { data: movements, error: movError } = await client
    .from('register_cash_movements')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at');
  if (movError) mapError(movError);
  return mapRegisterSession(data, (movements ?? []).map(mapCashMovement));
}

export async function getOpenRegister(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  locationId: string,
): Promise<RegisterSession | null> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('register_sessions')
    .select('*')
    .eq('business_id', businessId)
    .eq('location_id', locationId)
    .eq('status', 'open')
    .maybeSingle();
  if (error) mapError(error);
  if (!data) return null;
  return getRegisterSession(client, businessId, userId, data.id);
}

export async function getDailySummary(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  date: string,
  locationId: string,
): Promise<DailyPosSummary> {
  const caller = await getCaller(client, businessId, userId);
  if (!resolvePosPermissions(caller.role).canViewReports) {
    throw new PosServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  const { data: location, error: locError } = await client
    .from('business_locations')
    .select('timezone')
    .eq('id', locationId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (locError) mapError(locError);
  if (!location?.timezone) {
    throw new PosServiceError('Location not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  const { data: business } = await client
    .from('businesses')
    .select('default_currency')
    .eq('id', businessId)
    .maybeSingle();

  const bounds = localDayUtcBounds(date, location.timezone);
  const { data: sales, error } = await client
    .from('sales')
    .select('status, subtotal_minor, discount_minor, tax_minor, total_minor, amount_paid_minor, amount_refunded_minor')
    .eq('business_id', businessId)
    .eq('location_id', locationId)
    .gte('created_at', bounds.startUtc.toISO()!)
    .lt('created_at', bounds.endUtc.toISO()!);
  if (error) mapError(error);

  let saleCount = 0;
  let gross = 0;
  let discount = 0;
  let tax = 0;
  let netCollected = 0;
  let refunded = 0;
  let voidedCount = 0;
  for (const row of sales ?? []) {
    if (row.status === 'voided') {
      voidedCount += 1;
      continue;
    }
    saleCount += 1;
    gross += Number(row.subtotal_minor);
    discount += Number(row.discount_minor);
    tax += Number(row.tax_minor);
    netCollected += Number(row.amount_paid_minor) - Number(row.amount_refunded_minor);
    refunded += Number(row.amount_refunded_minor);
  }

  return mapDailySummary({
    date,
    locationId,
    timezone: location.timezone,
    currency: business?.default_currency ?? 'USD',
    saleCount,
    grossSalesMinor: gross,
    discountMinor: discount,
    taxMinor: tax,
    netCollectedMinor: netCollected,
    refundedMinor: refunded,
    voidedCount,
  });
}

