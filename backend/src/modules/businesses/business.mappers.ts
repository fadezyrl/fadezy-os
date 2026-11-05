import type {
  Business,
  BusinessLocation,
  BusinessMembership,
  BusinessRole,
  BusinessType,
  LocationType,
  MembershipStatus,
  OnboardingStatus,
} from '@fadezy/shared';

type BusinessRow = {
  id: string;
  name: string;
  slug: string;
  business_type: BusinessType;
  legal_name: string | null;
  description: string | null;
  email: string | null;
  phone: string | null;
  website_url: string | null;
  logo_url: string | null;
  country_code: string;
  default_currency: string;
  timezone: string;
  default_locale: string;
  onboarding_status: OnboardingStatus;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  id: string;
  business_id: string;
  user_id: string;
  role: BusinessRole;
  membership_status: MembershipStatus;
  created_at: string;
  updated_at: string;
};

type LocationRow = {
  id: string;
  business_id: string;
  name: string;
  location_type: LocationType;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string;
  state_region: string | null;
  postal_code: string | null;
  country_code: string;
  phone: string | null;
  email: string | null;
  timezone: string;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export function mapBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    businessType: row.business_type,
    legalName: row.legal_name,
    description: row.description,
    email: row.email,
    phone: row.phone,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    countryCode: row.country_code,
    defaultCurrency: row.default_currency,
    timezone: row.timezone,
    defaultLocale: row.default_locale,
    onboardingStatus: row.onboarding_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMembership(row: MemberRow): BusinessMembership {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: row.role,
    membershipStatus: row.membership_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapLocation(row: LocationRow): BusinessLocation {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    locationType: row.location_type,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    city: row.city,
    stateRegion: row.state_region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    phone: row.phone,
    email: row.email,
    timezone: row.timezone,
    isPrimary: row.is_primary,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRpcPayload(input: {
  name: string;
  slug: string;
  businessType: BusinessType;
  legalName?: string | null;
  description?: string | null;
  email?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  defaultLocale: string;
  clientRequestId?: string;
  primaryLocation: {
    name: string;
    locationType: LocationType;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city: string;
    stateRegion?: string | null;
    postalCode?: string | null;
    countryCode: string;
    phone?: string | null;
    email?: string | null;
    timezone: string;
  };
}) {
  return {
    name: input.name,
    slug: input.slug,
    business_type: input.businessType,
    legal_name: input.legalName ?? null,
    description: input.description ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    website_url: input.websiteUrl ?? null,
    country_code: input.countryCode,
    default_currency: input.defaultCurrency,
    timezone: input.timezone,
    default_locale: input.defaultLocale,
    client_request_id: input.clientRequestId ?? null,
    primary_location: {
      name: input.primaryLocation.name,
      location_type: input.primaryLocation.locationType,
      address_line_1: input.primaryLocation.addressLine1 ?? null,
      address_line_2: input.primaryLocation.addressLine2 ?? null,
      city: input.primaryLocation.city,
      state_region: input.primaryLocation.stateRegion ?? null,
      postal_code: input.primaryLocation.postalCode ?? null,
      country_code: input.primaryLocation.countryCode,
      phone: input.primaryLocation.phone ?? null,
      email: input.primaryLocation.email ?? null,
      timezone: input.primaryLocation.timezone,
    },
  };
}
