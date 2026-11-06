import type { SupabaseClient } from '@supabase/supabase-js';
import {
  API_ERROR_CODES,
  resolveBookingPermissions,
  resolvePosPermissions,
  type Booking,
  type BusinessRole,
  type Customer,
  type CustomerBookingsQuery,
  type CustomerInput,
  type CustomerListItem,
  type CustomerListQuery,
  type CustomerSummaryMetrics,
  type CustomerUpdateInput,
  type PaginatedCustomerBookings,
  type PaginatedCustomers,
} from '@fadezy/shared';
import { mapAddonLine, mapBooking, mapCustomer, mapServiceLine } from './customers.mappers';

export class CustomerServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CustomerServiceError';
  }
}

function mapError(error: { message?: string; code?: string; details?: string }): never {
  const haystack = `${error.message ?? ''} ${error.code ?? ''} ${error.details ?? ''}`.toLowerCase();
  if (haystack.includes('42501') || haystack.includes('forbidden')) {
    throw new CustomerServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }
  if (haystack.includes('23505') || haystack.includes('conflict')) {
    throw new CustomerServiceError('Conflict', API_ERROR_CODES.CONFLICT, 409);
  }
  throw new CustomerServiceError(
    error.message || 'Customer operation failed',
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
    throw new CustomerServiceError(
      'Business not found or not permitted',
      API_ERROR_CODES.NOT_FOUND,
      404,
    );
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

function emptySummary(
  canViewBookings: boolean,
  canViewSpend: boolean,
  currency: string | null,
): CustomerSummaryMetrics {
  return {
    lifetimeBookingCount: 0,
    lastVisitAt: null,
    nextAppointmentAt: null,
    netCollectedMinor: canViewSpend ? 0 : null,
    currency: canViewSpend ? currency : null,
    canViewSpend,
    canViewBookings,
  };
}

async function loadBusinessCurrency(
  client: SupabaseClient,
  businessId: string,
): Promise<string> {
  const { data } = await client
    .from('businesses')
    .select('default_currency')
    .eq('id', businessId)
    .maybeSingle();
  return data?.default_currency ?? 'USD';
}

/**
 * Batch-load CRM activity metrics for a set of customer ids (no N+1).
 * Booking visibility matches listCustomerBookings location rules.
 */
async function loadCustomerSummaries(
  client: SupabaseClient,
  businessId: string,
  caller: { role: BusinessRole; locationIds: string[] },
  customerIds: string[],
  currency: string,
): Promise<Map<string, CustomerSummaryMetrics>> {
  const bookingPerms = resolveBookingPermissions(caller.role);
  const canViewBookings = bookingPerms.canViewBookings;
  const canViewSpend = resolvePosPermissions(caller.role).canViewReports;
  const map = new Map<string, CustomerSummaryMetrics>();
  for (const id of customerIds) {
    map.set(id, emptySummary(canViewBookings, canViewSpend, currency));
  }
  if (!customerIds.length) return map;

  const nowIso = new Date().toISOString();

  if (canViewBookings) {
    const locationScoped =
      !bookingPerms.canManageAllLocations && caller.locationIds.length > 0;
    if (bookingPerms.canManageAllLocations || locationScoped) {
      let bookingQuery = client
        .from('bookings')
        .select('customer_id, starts_at, status')
        .eq('business_id', businessId)
        .in('customer_id', customerIds);
      if (!bookingPerms.canManageAllLocations) {
        bookingQuery = bookingQuery.in('location_id', caller.locationIds);
      }
      const { data: bookingRows, error: bookingError } = await bookingQuery;
      if (bookingError) mapError(bookingError);

      for (const row of bookingRows ?? []) {
        const summary = map.get(row.customer_id);
        if (!summary) continue;
        summary.lifetimeBookingCount += 1;
        if (row.starts_at <= nowIso) {
          if (!summary.lastVisitAt || row.starts_at > summary.lastVisitAt) {
            summary.lastVisitAt = row.starts_at;
          }
        }
        if (row.status === 'confirmed' && row.starts_at >= nowIso) {
          if (!summary.nextAppointmentAt || row.starts_at < summary.nextAppointmentAt) {
            summary.nextAppointmentAt = row.starts_at;
          }
        }
      }
    }
  }

  if (canViewSpend) {
    const { data: saleRows, error: saleError } = await client
      .from('sales')
      .select('customer_id, status, amount_paid_minor, amount_refunded_minor')
      .eq('business_id', businessId)
      .in('customer_id', customerIds)
      .neq('status', 'voided');
    if (saleError) mapError(saleError);

    for (const row of saleRows ?? []) {
      const summary = map.get(row.customer_id);
      if (!summary || summary.netCollectedMinor == null) continue;
      summary.netCollectedMinor +=
        Number(row.amount_paid_minor) - Number(row.amount_refunded_minor);
    }
  }

  return map;
}

export async function listCustomers(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  query: CustomerListQuery,
): Promise<PaginatedCustomers> {
  const caller = await getCaller(client, businessId, userId);
  const ascending = query.order !== 'desc';
  const sortColumn = query.sort === 'created_at' ? 'created_at' : 'full_name';

  let builder = client
    .from('customers')
    .select('*', { count: 'exact' })
    .eq('business_id', businessId)
    .order(sortColumn, { ascending })
    .order('id', { ascending: true })
    .range(query.offset, query.offset + query.limit - 1);

  if (query.status === 'active') {
    builder = builder.is('archived_at', null);
  } else if (query.status === 'archived') {
    builder = builder.not('archived_at', 'is', null);
  }

  if (query.q) {
    const term = query.q.replace(/[%_,]/g, '');
    if (term) {
      builder = builder.or(
        `full_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`,
      );
    }
  }

  const { data, error, count } = await builder;
  if (error) mapError(error);

  const customers = (data ?? []).map(mapCustomer);
  const currency = await loadBusinessCurrency(client, businessId);
  const summaries = await loadCustomerSummaries(
    client,
    businessId,
    caller,
    customers.map((item) => item.id),
    currency,
  );

  const items: CustomerListItem[] = customers.map((customer) => ({
    ...customer,
    summary:
      summaries.get(customer.id) ??
      emptySummary(
        resolveBookingPermissions(caller.role).canViewBookings,
        resolvePosPermissions(caller.role).canViewReports,
        currency,
      ),
  }));

  return {
    items,
    meta: {
      total: count ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
  };
}

export async function createCustomer(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  input: CustomerInput,
): Promise<Customer> {
  await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('customers')
    .insert({
      business_id: businessId,
      full_name: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
    })
    .select('*')
    .single();
  if (error) mapError(error);
  return mapCustomer(data);
}

export async function getCustomer(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  customerId: string,
): Promise<CustomerListItem> {
  const caller = await getCaller(client, businessId, userId);
  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) mapError(error);
  if (!data) {
    throw new CustomerServiceError('Customer not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  const customer = mapCustomer(data);
  const currency = await loadBusinessCurrency(client, businessId);
  const summaries = await loadCustomerSummaries(
    client,
    businessId,
    caller,
    [customer.id],
    currency,
  );
  return {
    ...customer,
    summary:
      summaries.get(customer.id) ??
      emptySummary(
        resolveBookingPermissions(caller.role).canViewBookings,
        resolvePosPermissions(caller.role).canViewReports,
        currency,
      ),
  };
}

export async function updateCustomer(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  customerId: string,
  input: CustomerUpdateInput,
): Promise<Customer> {
  await getCaller(client, businessId, userId);

  const patch: Record<string, string | null> = {};
  if (input.fullName !== undefined) patch.full_name = input.fullName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.notes !== undefined) patch.notes = input.notes;

  const { data, error } = await client
    .from('customers')
    .update(patch)
    .eq('id', customerId)
    .eq('business_id', businessId)
    .select('*')
    .maybeSingle();
  if (error) mapError(error);
  if (!data) {
    throw new CustomerServiceError('Customer not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return mapCustomer(data);
}

export async function archiveCustomer(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  customerId: string,
): Promise<Customer> {
  const existing = await getCustomer(client, businessId, userId, customerId);
  if (existing.archivedAt) return existing;

  const { data, error } = await client
    .from('customers')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('business_id', businessId)
    .select('*')
    .maybeSingle();
  if (error) mapError(error);
  if (!data) {
    throw new CustomerServiceError('Customer not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return mapCustomer(data);
}

export async function restoreCustomer(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  customerId: string,
): Promise<Customer> {
  const existing = await getCustomer(client, businessId, userId, customerId);
  if (!existing.archivedAt) return existing;

  const { data, error } = await client
    .from('customers')
    .update({ archived_at: null })
    .eq('id', customerId)
    .eq('business_id', businessId)
    .select('*')
    .maybeSingle();
  if (error) mapError(error);
  if (!data) {
    throw new CustomerServiceError('Customer not found', API_ERROR_CODES.NOT_FOUND, 404);
  }
  return mapCustomer(data);
}

export async function listCustomerBookings(
  client: SupabaseClient,
  businessId: string,
  userId: string,
  customerId: string,
  query: CustomerBookingsQuery,
): Promise<PaginatedCustomerBookings> {
  const caller = await getCaller(client, businessId, userId);
  const permissions = resolveBookingPermissions(caller.role);
  if (!permissions.canViewBookings) {
    throw new CustomerServiceError('Not permitted', API_ERROR_CODES.FORBIDDEN, 403);
  }

  await getCustomer(client, businessId, userId, customerId);

  if (!permissions.canManageAllLocations && !caller.locationIds.length) {
    return {
      items: [],
      meta: { total: 0, limit: query.limit, offset: query.offset },
    };
  }

  let builder = client
    .from('bookings')
    .select('*', { count: 'exact' })
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .order('starts_at', { ascending: false })
    .order('id', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1);

  if (!permissions.canManageAllLocations) {
    builder = builder.in('location_id', caller.locationIds);
  }
  if (query.status) {
    builder = builder.eq('status', query.status);
  }

  const { data, error, count } = await builder;
  if (error) mapError(error);

  const rows = data ?? [];
  const ids = rows.map((row) => row.id);
  if (!ids.length) {
    return {
      items: [],
      meta: {
        total: count ?? 0,
        limit: query.limit,
        offset: query.offset,
      },
    };
  }

  const [{ data: services }, { data: addons }] = await Promise.all([
    client.from('booking_services').select('*').in('booking_id', ids),
    client.from('booking_addons').select('*').in('booking_id', ids),
  ]);

  const items: Booking[] = rows.map((row) =>
    mapBooking(
      row,
      (services ?? []).filter((item) => item.booking_id === row.id).map(mapServiceLine),
      (addons ?? []).filter((item) => item.booking_id === row.id).map(mapAddonLine),
    ),
  );

  return {
    items,
    meta: {
      total: count ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
  };
}
