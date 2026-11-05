export const CATALOG_STATUSES = ['active', 'inactive', 'archived'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export interface MoneyAmount {
  /** Integer minor units (e.g. cents for USD, yen for JPY). Never a float. */
  amountMinor: number;
  /** ISO 4217 code snapshotted on the priced record. */
  currency: string;
}

export interface ServiceCategory {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  serviceCount?: number;
}

export interface Service {
  id: string;
  businessId: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceMinor: number;
  currency: string;
  durationMinutes: number;
  processingMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  sortOrder: number;
  isActive: boolean;
  isBookableOnline: boolean;
  isWalkIn: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  category?: ServiceCategory | null;
  locationSettings?: ServiceLocationSetting[];
  addonIds?: string[];
}

export interface ServiceLocationSetting {
  id: string;
  businessId: string;
  serviceId: string;
  locationId: string;
  isAvailable: boolean;
  /** Null means inherit the service default price. */
  priceMinor: number | null;
  /** Null when inheriting; when set must equal the service currency. */
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceAddon {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  durationMinutes: number;
  isActive: boolean;
  isOptionalDefault: boolean;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  linkedServiceIds?: string[];
}

export interface ServiceAddonLink {
  id: string;
  businessId: string;
  serviceId: string;
  addonId: string;
  isOptional: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogListMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface PaginatedCatalog<T> {
  items: T[];
  meta: CatalogListMeta;
}
