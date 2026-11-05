import type {
  Service,
  ServiceAddon,
  ServiceAddonLink,
  ServiceCategory,
  ServiceLocationSetting,
} from '@fadezy/shared';

type CategoryRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ServiceRow = {
  id: string;
  business_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  price_minor: number | string;
  currency: string;
  duration_minutes: number;
  processing_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  sort_order: number;
  is_active: boolean;
  is_bookable_online: boolean;
  is_walk_in: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type LocationSettingRow = {
  id: string;
  business_id: string;
  service_id: string;
  location_id: string;
  is_available: boolean;
  price_minor: number | string | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
};

type AddonRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  price_minor: number | string;
  currency: string;
  duration_minutes: number;
  is_active: boolean;
  is_optional_default: boolean;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type AddonLinkRow = {
  id: string;
  business_id: string;
  service_id: string;
  addon_id: string;
  is_optional: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function toMinor(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? Number(value) : value;
}

export function mapCategory(row: CategoryRow, serviceCount?: number): ServiceCategory {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(serviceCount === undefined ? {} : { serviceCount }),
  };
}

export function mapService(row: ServiceRow): Service {
  return {
    id: row.id,
    businessId: row.business_id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url,
    priceMinor: toMinor(row.price_minor) ?? 0,
    currency: row.currency,
    durationMinutes: row.duration_minutes,
    processingMinutes: row.processing_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    isBookableOnline: row.is_bookable_online,
    isWalkIn: row.is_walk_in,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapLocationSetting(row: LocationSettingRow): ServiceLocationSetting {
  return {
    id: row.id,
    businessId: row.business_id,
    serviceId: row.service_id,
    locationId: row.location_id,
    isAvailable: row.is_available,
    priceMinor: toMinor(row.price_minor),
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAddon(row: AddonRow): ServiceAddon {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    priceMinor: toMinor(row.price_minor) ?? 0,
    currency: row.currency,
    durationMinutes: row.duration_minutes,
    isActive: row.is_active,
    isOptionalDefault: row.is_optional_default,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAddonLink(row: AddonLinkRow): ServiceAddonLink {
  return {
    id: row.id,
    businessId: row.business_id,
    serviceId: row.service_id,
    addonId: row.addon_id,
    isOptional: row.is_optional,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
