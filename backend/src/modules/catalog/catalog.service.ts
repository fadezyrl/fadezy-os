import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CatalogListQuery,
  CreateServiceAddonInput,
  CreateServiceCategoryInput,
  CreateServiceInput,
  PaginatedCatalog,
  ReorderItemsInput,
  Service,
  ServiceAddon,
  ServiceCategory,
  ServiceLocationSetting,
  SetServiceAddonsInput,
  UpdateServiceAddonInput,
  UpdateServiceCategoryInput,
  UpdateServiceInput,
  UpsertServiceLocationSettingsInput,
} from '@fadezy/shared';
import {
  mapAddon,
  mapCategory,
  mapLocationSetting,
  mapService,
} from './catalog.mappers';

export class CatalogServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function mapDbError(error: { message?: string; code?: string } | null): never {
  const message = error?.message ?? 'Database operation failed';
  const lower = message.toLowerCase();

  if (error?.code === '23505') {
    throw new CatalogServiceError('Catalog record conflict', 'CONFLICT', 409);
  }
  if (
    lower.includes('cross_business') ||
    lower.includes('location_currency_mismatch') ||
    error?.code === '23514'
  ) {
    throw new CatalogServiceError('Invalid cross-tenant or currency relationship', 'VALIDATION_ERROR', 422);
  }
  if (
    error?.code === '42501' ||
    error?.code === 'PGRST301' ||
    lower.includes('row-level security') ||
    lower.includes('permission denied') ||
    lower.includes('violates row-level security')
  ) {
    throw new CatalogServiceError('Not permitted for this business catalog', 'FORBIDDEN', 403);
  }

  throw new CatalogServiceError('Unable to complete catalog operation', 'INTERNAL_ERROR', 500);
}

async function assertBusinessMember(
  client: SupabaseClient,
  businessId: string,
): Promise<{ defaultCurrency: string }> {
  const { data, error } = await client
    .from('businesses')
    .select('id, default_currency')
    .eq('id', businessId)
    .maybeSingle();

  if (error) mapDbError(error);
  if (!data) {
    throw new CatalogServiceError('Business not found or not permitted', 'NOT_FOUND', 404);
  }
  return { defaultCurrency: String(data.default_currency).toUpperCase() };
}

async function getServiceRow(client: SupabaseClient, businessId: string, serviceId: string) {
  const { data, error } = await client
    .from('services')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', serviceId)
    .maybeSingle();
  if (error) mapDbError(error);
  if (!data) {
    throw new CatalogServiceError('Service not found', 'NOT_FOUND', 404);
  }
  return data;
}

// ---- Categories ----

export async function listCategories(
  client: SupabaseClient,
  businessId: string,
  includeArchived = false,
): Promise<ServiceCategory[]> {
  await assertBusinessMember(client, businessId);

  let query = client
    .from('service_categories')
    .select('*')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  const { data, error } = await query;
  if (error) mapDbError(error);

  const categories = data ?? [];
  const ids = categories.map((row) => row.id);
  const counts = new Map<string, number>();

  if (ids.length) {
    const { data: services, error: serviceError } = await client
      .from('services')
      .select('category_id')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .in('category_id', ids);
    if (serviceError) mapDbError(serviceError);
    for (const row of services ?? []) {
      if (!row.category_id) continue;
      counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
    }
  }

  return categories.map((row) => mapCategory(row, counts.get(row.id) ?? 0));
}

export async function createCategory(
  client: SupabaseClient,
  businessId: string,
  input: CreateServiceCategoryInput,
): Promise<ServiceCategory> {
  await assertBusinessMember(client, businessId);

  const { data, error } = await client
    .from('service_categories')
    .insert({
      business_id: businessId,
      name: input.name.trim(),
      description: input.description ?? null,
      image_url: input.imageUrl ?? null,
      sort_order: input.sortOrder ?? 0,
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single();

  if (error) mapDbError(error);
  return mapCategory(data, 0);
}

export async function getCategory(
  client: SupabaseClient,
  businessId: string,
  categoryId: string,
): Promise<ServiceCategory> {
  await assertBusinessMember(client, businessId);
  const { data, error } = await client
    .from('service_categories')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', categoryId)
    .maybeSingle();
  if (error) mapDbError(error);
  if (!data) throw new CatalogServiceError('Category not found', 'NOT_FOUND', 404);

  const { count, error: countError } = await client
    .from('services')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('category_id', categoryId)
    .is('archived_at', null);
  if (countError) mapDbError(countError);

  return mapCategory(data, count ?? 0);
}

export async function updateCategory(
  client: SupabaseClient,
  businessId: string,
  categoryId: string,
  input: UpdateServiceCategoryInput,
): Promise<ServiceCategory> {
  await assertBusinessMember(client, businessId);
  const existing = await getCategory(client, businessId, categoryId);

  if (input.reassignServicesToCategoryId !== undefined) {
    const targetId = input.reassignServicesToCategoryId;
    if (targetId) {
      await getCategory(client, businessId, targetId);
    }
    const { error: reassignError } = await client
      .from('services')
      .update({ category_id: targetId })
      .eq('business_id', businessId)
      .eq('category_id', categoryId);
    if (reassignError) mapDbError(reassignError);
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.imageUrl !== undefined) patch.image_url = input.imageUrl;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  if (Object.keys(patch).length) {
    const { error } = await client
      .from('service_categories')
      .update(patch)
      .eq('business_id', businessId)
      .eq('id', categoryId);
    if (error) mapDbError(error);
  }

  return getCategory(client, businessId, existing.id);
}

export async function archiveCategory(
  client: SupabaseClient,
  businessId: string,
  categoryId: string,
  options?: { reassignServicesToCategoryId?: string | null; forceWithServices?: boolean },
): Promise<ServiceCategory> {
  const category = await getCategory(client, businessId, categoryId);
  if (category.archivedAt) return category;

  const activeCount = category.serviceCount ?? 0;
  if (activeCount > 0 && !options?.forceWithServices && options?.reassignServicesToCategoryId === undefined) {
    throw new CatalogServiceError(
      'Category has active services. Reassign them or pass forceWithServices to archive while keeping links.',
      'CONFLICT',
      409,
    );
  }

  if (options?.reassignServicesToCategoryId !== undefined) {
    const targetId = options.reassignServicesToCategoryId;
    if (targetId) await getCategory(client, businessId, targetId);
    const { error } = await client
      .from('services')
      .update({ category_id: targetId })
      .eq('business_id', businessId)
      .eq('category_id', categoryId)
      .is('archived_at', null);
    if (error) mapDbError(error);
  }

  const { error } = await client
    .from('service_categories')
    .update({
      archived_at: new Date().toISOString(),
      is_active: false,
    })
    .eq('business_id', businessId)
    .eq('id', categoryId);
  if (error) mapDbError(error);

  return getCategory(client, businessId, categoryId);
}

export async function reorderCategories(
  client: SupabaseClient,
  businessId: string,
  input: ReorderItemsInput,
): Promise<ServiceCategory[]> {
  await assertBusinessMember(client, businessId);
  for (const item of input.items) {
    const { error } = await client
      .from('service_categories')
      .update({ sort_order: item.sortOrder })
      .eq('business_id', businessId)
      .eq('id', item.id)
      .is('archived_at', null);
    if (error) mapDbError(error);
  }
  return listCategories(client, businessId, false);
}

// ---- Services ----

export async function listServices(
  client: SupabaseClient,
  businessId: string,
  query: CatalogListQuery,
): Promise<PaginatedCatalog<Service>> {
  await assertBusinessMember(client, businessId);

  let builder = client
    .from('services')
    .select('*', { count: 'exact' })
    .eq('business_id', businessId);

  if (query.status === 'archived') {
    builder = builder.not('archived_at', 'is', null);
  } else if (query.status === 'inactive') {
    builder = builder.is('archived_at', null).eq('is_active', false);
  } else if (query.status === 'all' || query.includeArchived) {
    // no archive filter
  } else {
    builder = builder.is('archived_at', null).eq('is_active', true);
  }

  if (query.categoryId) {
    builder = builder.eq('category_id', query.categoryId);
  }
  if (query.q) {
    builder = builder.ilike('name', `%${query.q}%`);
  }

  if (query.locationId) {
    const { data: settings, error: settingsError } = await client
      .from('service_location_settings')
      .select('service_id')
      .eq('business_id', businessId)
      .eq('location_id', query.locationId)
      .eq('is_available', true);
    if (settingsError) mapDbError(settingsError);
    const ids = (settings ?? []).map((row) => row.service_id);
    if (!ids.length) {
      return { items: [], meta: { total: 0, limit: query.limit, offset: query.offset } };
    }
    builder = builder.in('id', ids);
  }

  const { data, error, count } = await builder
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .range(query.offset, query.offset + query.limit - 1);

  if (error) mapDbError(error);

  return {
    items: (data ?? []).map(mapService),
    meta: {
      total: count ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
  };
}

export async function getService(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<Service> {
  await assertBusinessMember(client, businessId);
  const row = await getServiceRow(client, businessId, serviceId);
  const service = mapService(row);

  const [{ data: settings }, { data: links }, category] = await Promise.all([
    client
      .from('service_location_settings')
      .select('*')
      .eq('business_id', businessId)
      .eq('service_id', serviceId),
    client
      .from('service_addon_links')
      .select('*')
      .eq('business_id', businessId)
      .eq('service_id', serviceId)
      .order('sort_order', { ascending: true }),
    service.categoryId
      ? client
          .from('service_categories')
          .select('*')
          .eq('id', service.categoryId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (category && 'error' in category && category.error) mapDbError(category.error);

  return {
    ...service,
    category: category && 'data' in category && category.data ? mapCategory(category.data) : null,
    locationSettings: (settings ?? []).map(mapLocationSetting),
    addonIds: (links ?? []).map((link) => link.addon_id),
  };
}

async function ensureCategoryBelongs(
  client: SupabaseClient,
  businessId: string,
  categoryId: string | null | undefined,
) {
  if (!categoryId) return;
  const { data, error } = await client
    .from('service_categories')
    .select('id, archived_at')
    .eq('business_id', businessId)
    .eq('id', categoryId)
    .maybeSingle();
  if (error) mapDbError(error);
  if (!data || data.archived_at) {
    throw new CatalogServiceError('Category not found or archived', 'VALIDATION_ERROR', 422);
  }
}

async function syncServiceLocations(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
  locationIds: string[],
) {
  const { data: locations, error } = await client
    .from('business_locations')
    .select('id')
    .eq('business_id', businessId)
    .in('id', locationIds);
  if (error) mapDbError(error);
  if ((locations ?? []).length !== locationIds.length) {
    throw new CatalogServiceError('One or more locations are invalid for this business', 'VALIDATION_ERROR', 422);
  }

  const { error: deleteError } = await client
    .from('service_location_settings')
    .delete()
    .eq('business_id', businessId)
    .eq('service_id', serviceId);
  if (deleteError) mapDbError(deleteError);

  if (!locationIds.length) return;

  const { error: insertError } = await client.from('service_location_settings').insert(
    locationIds.map((locationId) => ({
      business_id: businessId,
      service_id: serviceId,
      location_id: locationId,
      is_available: true,
      price_minor: null,
      currency: null,
    })),
  );
  if (insertError) mapDbError(insertError);
}

async function syncServiceAddons(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
  addonIds: string[],
) {
  if (addonIds.length) {
    const { data: addons, error } = await client
      .from('service_addons')
      .select('id')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .in('id', addonIds);
    if (error) mapDbError(error);
    if ((addons ?? []).length !== addonIds.length) {
      throw new CatalogServiceError('One or more add-ons are invalid for this business', 'VALIDATION_ERROR', 422);
    }
  }

  const { error: deleteError } = await client
    .from('service_addon_links')
    .delete()
    .eq('business_id', businessId)
    .eq('service_id', serviceId);
  if (deleteError) mapDbError(deleteError);

  if (!addonIds.length) return;

  const { error: insertError } = await client.from('service_addon_links').insert(
    addonIds.map((addonId, index) => ({
      business_id: businessId,
      service_id: serviceId,
      addon_id: addonId,
      is_optional: true,
      sort_order: index,
    })),
  );
  if (insertError) mapDbError(insertError);
}

export async function createService(
  client: SupabaseClient,
  businessId: string,
  input: CreateServiceInput,
): Promise<Service> {
  const { defaultCurrency } = await assertBusinessMember(client, businessId);
  const currency = defaultCurrency;

  if (input.currency && input.currency !== currency) {
    throw new CatalogServiceError(
      `Service currency must match business default (${currency}). Currency conversion is not supported.`,
      'VALIDATION_ERROR',
      422,
    );
  }

  await ensureCategoryBelongs(client, businessId, input.categoryId);

  const { data, error } = await client
    .from('services')
    .insert({
      business_id: businessId,
      category_id: input.categoryId ?? null,
      name: input.name.trim(),
      description: input.description ?? null,
      image_url: input.imageUrl ?? null,
      price_minor: input.priceMinor,
      currency,
      duration_minutes: input.durationMinutes,
      processing_minutes: input.processingMinutes ?? 0,
      buffer_before_minutes: input.bufferBeforeMinutes ?? 0,
      buffer_after_minutes: input.bufferAfterMinutes ?? 0,
      sort_order: input.sortOrder ?? 0,
      is_active: input.isActive ?? true,
      is_bookable_online: input.isBookableOnline ?? true,
      is_walk_in: input.isWalkIn ?? true,
    })
    .select('*')
    .single();

  if (error) mapDbError(error);

  if (input.locationIds) {
    await syncServiceLocations(client, businessId, data.id, input.locationIds);
  }
  if (input.addonIds) {
    await syncServiceAddons(client, businessId, data.id, input.addonIds);
  }

  return getService(client, businessId, data.id);
}

export async function updateService(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
  input: UpdateServiceInput,
): Promise<Service> {
  const existing = await getServiceRow(client, businessId, serviceId);

  if (input.currency && input.currency !== existing.currency) {
    throw new CatalogServiceError(
      'Changing service currency is not supported. Create a new service instead.',
      'VALIDATION_ERROR',
      422,
    );
  }

  if (input.categoryId !== undefined) {
    await ensureCategoryBelongs(client, businessId, input.categoryId);
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.categoryId !== undefined) patch.category_id = input.categoryId;
  if (input.description !== undefined) patch.description = input.description;
  if (input.imageUrl !== undefined) patch.image_url = input.imageUrl;
  if (input.priceMinor !== undefined) patch.price_minor = input.priceMinor;
  if (input.durationMinutes !== undefined) patch.duration_minutes = input.durationMinutes;
  if (input.processingMinutes !== undefined) patch.processing_minutes = input.processingMinutes;
  if (input.bufferBeforeMinutes !== undefined) patch.buffer_before_minutes = input.bufferBeforeMinutes;
  if (input.bufferAfterMinutes !== undefined) patch.buffer_after_minutes = input.bufferAfterMinutes;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.isBookableOnline !== undefined) patch.is_bookable_online = input.isBookableOnline;
  if (input.isWalkIn !== undefined) patch.is_walk_in = input.isWalkIn;

  if (Object.keys(patch).length) {
    const { error } = await client
      .from('services')
      .update(patch)
      .eq('business_id', businessId)
      .eq('id', serviceId);
    if (error) mapDbError(error);
  }

  if (input.locationIds) {
    await syncServiceLocations(client, businessId, serviceId, input.locationIds);
  }
  if (input.addonIds) {
    await syncServiceAddons(client, businessId, serviceId, input.addonIds);
  }

  return getService(client, businessId, serviceId);
}

export async function archiveService(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<Service> {
  await getServiceRow(client, businessId, serviceId);
  const { error } = await client
    .from('services')
    .update({
      archived_at: new Date().toISOString(),
      is_active: false,
      is_bookable_online: false,
    })
    .eq('business_id', businessId)
    .eq('id', serviceId);
  if (error) mapDbError(error);
  return getService(client, businessId, serviceId);
}

export async function reorderServices(
  client: SupabaseClient,
  businessId: string,
  input: ReorderItemsInput,
): Promise<void> {
  await assertBusinessMember(client, businessId);
  for (const item of input.items) {
    const { error } = await client
      .from('services')
      .update({ sort_order: item.sortOrder })
      .eq('business_id', businessId)
      .eq('id', item.id)
      .is('archived_at', null);
    if (error) mapDbError(error);
  }
}

export async function upsertLocationSettings(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
  input: UpsertServiceLocationSettingsInput,
): Promise<ServiceLocationSetting[]> {
  const service = await getServiceRow(client, businessId, serviceId);
  const locationIds = input.settings.map((item) => item.locationId);

  const { data: locations, error: locationError } = await client
    .from('business_locations')
    .select('id')
    .eq('business_id', businessId)
    .in('id', locationIds);
  if (locationError) mapDbError(locationError);
  if ((locations ?? []).length !== locationIds.length) {
    throw new CatalogServiceError('One or more locations are invalid for this business', 'VALIDATION_ERROR', 422);
  }

  for (const setting of input.settings) {
    const priceMinor = setting.priceMinor === undefined ? null : setting.priceMinor;
    const row = {
      business_id: businessId,
      service_id: serviceId,
      location_id: setting.locationId,
      is_available: setting.isAvailable,
      price_minor: priceMinor,
      currency: priceMinor === null ? null : service.currency,
    };

    const { data: existing, error: existingError } = await client
      .from('service_location_settings')
      .select('id')
      .eq('service_id', serviceId)
      .eq('location_id', setting.locationId)
      .maybeSingle();
    if (existingError) mapDbError(existingError);

    if (existing) {
      const { error } = await client
        .from('service_location_settings')
        .update(row)
        .eq('id', existing.id);
      if (error) mapDbError(error);
    } else {
      const { error } = await client.from('service_location_settings').insert(row);
      if (error) mapDbError(error);
    }
  }

  const { data, error } = await client
    .from('service_location_settings')
    .select('*')
    .eq('business_id', businessId)
    .eq('service_id', serviceId)
    .order('created_at', { ascending: true });
  if (error) mapDbError(error);
  return (data ?? []).map(mapLocationSetting);
}

export async function setServiceAddons(
  client: SupabaseClient,
  businessId: string,
  serviceId: string,
  input: SetServiceAddonsInput,
): Promise<Service> {
  await getServiceRow(client, businessId, serviceId);
  await syncServiceAddons(
    client,
    businessId,
    serviceId,
    input.items.map((item) => item.addonId),
  );

  // Apply optional/sort metadata
  for (const item of input.items) {
    const { error } = await client
      .from('service_addon_links')
      .update({
        is_optional: item.isOptional ?? true,
        sort_order: item.sortOrder ?? 0,
      })
      .eq('business_id', businessId)
      .eq('service_id', serviceId)
      .eq('addon_id', item.addonId);
    if (error) mapDbError(error);
  }

  return getService(client, businessId, serviceId);
}

// ---- Add-ons ----

export async function listAddons(
  client: SupabaseClient,
  businessId: string,
  includeArchived = false,
): Promise<ServiceAddon[]> {
  await assertBusinessMember(client, businessId);
  let query = client
    .from('service_addons')
    .select('*')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (!includeArchived) query = query.is('archived_at', null);

  const { data, error } = await query;
  if (error) mapDbError(error);

  const addons = data ?? [];
  const ids = addons.map((row) => row.id);
  const linksByAddon = new Map<string, string[]>();

  if (ids.length) {
    const { data: links, error: linkError } = await client
      .from('service_addon_links')
      .select('addon_id, service_id')
      .eq('business_id', businessId)
      .in('addon_id', ids);
    if (linkError) mapDbError(linkError);
    for (const link of links ?? []) {
      const list = linksByAddon.get(link.addon_id) ?? [];
      list.push(link.service_id);
      linksByAddon.set(link.addon_id, list);
    }
  }

  return addons.map((row) => ({
    ...mapAddon(row),
    linkedServiceIds: linksByAddon.get(row.id) ?? [],
  }));
}

export async function createAddon(
  client: SupabaseClient,
  businessId: string,
  input: CreateServiceAddonInput,
): Promise<ServiceAddon> {
  const { defaultCurrency } = await assertBusinessMember(client, businessId);
  const currency = defaultCurrency;
  if (input.currency && input.currency !== currency) {
    throw new CatalogServiceError(
      `Add-on currency must match business default (${currency}).`,
      'VALIDATION_ERROR',
      422,
    );
  }

  const { data, error } = await client
    .from('service_addons')
    .insert({
      business_id: businessId,
      name: input.name.trim(),
      description: input.description ?? null,
      price_minor: input.priceMinor,
      currency,
      duration_minutes: input.durationMinutes ?? 0,
      is_active: input.isActive ?? true,
      is_optional_default: input.isOptionalDefault ?? true,
      sort_order: input.sortOrder ?? 0,
    })
    .select('*')
    .single();
  if (error) mapDbError(error);

  if (input.serviceIds?.length) {
    for (const serviceId of input.serviceIds) {
      await getServiceRow(client, businessId, serviceId);
      const { error: linkError } = await client.from('service_addon_links').insert({
        business_id: businessId,
        service_id: serviceId,
        addon_id: data.id,
        is_optional: input.isOptionalDefault ?? true,
        sort_order: 0,
      });
      if (linkError) mapDbError(linkError);
    }
  }

  const list = await listAddons(client, businessId, true);
  return list.find((item) => item.id === data.id)!;
}

export async function updateAddon(
  client: SupabaseClient,
  businessId: string,
  addonId: string,
  input: UpdateServiceAddonInput,
): Promise<ServiceAddon> {
  await assertBusinessMember(client, businessId);
  const { data: existing, error: existingError } = await client
    .from('service_addons')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', addonId)
    .maybeSingle();
  if (existingError) mapDbError(existingError);
  if (!existing) throw new CatalogServiceError('Add-on not found', 'NOT_FOUND', 404);

  if (input.currency && input.currency !== existing.currency) {
    throw new CatalogServiceError(
      'Changing add-on currency is not supported.',
      'VALIDATION_ERROR',
      422,
    );
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.priceMinor !== undefined) patch.price_minor = input.priceMinor;
  if (input.durationMinutes !== undefined) patch.duration_minutes = input.durationMinutes;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.isOptionalDefault !== undefined) patch.is_optional_default = input.isOptionalDefault;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;

  if (Object.keys(patch).length) {
    const { error } = await client
      .from('service_addons')
      .update(patch)
      .eq('business_id', businessId)
      .eq('id', addonId);
    if (error) mapDbError(error);
  }

  if (input.serviceIds) {
    const { error: deleteError } = await client
      .from('service_addon_links')
      .delete()
      .eq('business_id', businessId)
      .eq('addon_id', addonId);
    if (deleteError) mapDbError(deleteError);

    for (const [index, serviceId] of input.serviceIds.entries()) {
      await getServiceRow(client, businessId, serviceId);
      const { error: linkError } = await client.from('service_addon_links').insert({
        business_id: businessId,
        service_id: serviceId,
        addon_id: addonId,
        is_optional: existing.is_optional_default,
        sort_order: index,
      });
      if (linkError) mapDbError(linkError);
    }
  }

  const list = await listAddons(client, businessId, true);
  return list.find((item) => item.id === addonId)!;
}

export async function archiveAddon(
  client: SupabaseClient,
  businessId: string,
  addonId: string,
): Promise<ServiceAddon> {
  await assertBusinessMember(client, businessId);
  const { error } = await client
    .from('service_addons')
    .update({
      archived_at: new Date().toISOString(),
      is_active: false,
    })
    .eq('business_id', businessId)
    .eq('id', addonId);
  if (error) mapDbError(error);

  const list = await listAddons(client, businessId, true);
  const addon = list.find((item) => item.id === addonId);
  if (!addon) throw new CatalogServiceError('Add-on not found', 'NOT_FOUND', 404);
  return addon;
}
