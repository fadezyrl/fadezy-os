export const BUSINESS_TYPES = ['barbershop', 'beauty_salon'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_ROLES = ['owner', 'manager', 'staff'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const ONBOARDING_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const LOCATION_TYPES = ['salon', 'studio', 'mobile', 'other'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export interface Business {
  id: string;
  name: string;
  slug: string;
  businessType: BusinessType;
  legalName: string | null;
  description: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  defaultLocale: string;
  onboardingStatus: OnboardingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessMembership {
  id: string;
  businessId: string;
  userId: string;
  role: BusinessRole;
  membershipStatus: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessLocation {
  id: string;
  businessId: string;
  name: string;
  locationType: LocationType;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string;
  stateRegion: string | null;
  postalCode: string | null;
  countryCode: string;
  phone: string | null;
  email: string | null;
  timezone: string;
  isPrimary: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessSummary extends Business {
  role: BusinessRole;
  primaryLocation: BusinessLocation | null;
}

export interface CreateBusinessResult {
  business: Business;
  membership: BusinessMembership;
  primaryLocation: BusinessLocation;
}

export interface OnboardingDraft {
  userId: string;
  draft: Record<string, unknown>;
  updatedAt: string;
}
