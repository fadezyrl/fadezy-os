import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Business,
  BusinessLocation,
  BusinessMembership,
  BusinessSummary,
  CreateBusinessInput,
  CreateLocationInput,
  UpdateBusinessInput,
} from '@fadezy/shared';
import { mapBusiness, mapLocation, mapMembership, toRpcPayload } from './business.mappers';

export class BusinessServiceError extends Error {
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

  if (lower.includes('slug_or_request_conflict') || error?.code === '23505') {
    throw new BusinessServiceError('Business slug already exists', 'CONFLICT', 409);
  }
  if (lower.includes('auth_required')) {
    throw new BusinessServiceError('Authentication required', 'UNAUTHORIZED', 401);
  }
  if (lower.includes('primary_location_required')) {
    throw new BusinessServiceError('Primary location is required', 'VALIDATION_ERROR', 422);
  }
  // RLS / privilege denials from Postgres or PostgREST
  if (
    error?.code === '42501' ||
    error?.code === 'PGRST301' ||
    lower.includes('row-level security') ||
    lower.includes('permission denied') ||
    lower.includes('violates row-level security')
  ) {
    throw new BusinessServiceError('Not permitted for this business', 'FORBIDDEN', 403);
  }

  throw new BusinessServiceError('Unable to complete business operation', 'INTERNAL_ERROR', 500);
}

export async function listAccessibleBusinesses(
  client: SupabaseClient,
  userId: string,
): Promise<BusinessSummary[]> {
  const { data: memberships, error: membershipError } = await client
    .from('business_members')
    .select('role, business_id')
    .eq('user_id', userId)
    .eq('membership_status', 'active');

  if (membershipError) {
    mapDbError(membershipError);
  }

  if (!memberships?.length) {
    return [];
  }

  const businessIds = memberships.map((row) => row.business_id);
  const { data: businesses, error: businessError } = await client
    .from('businesses')
    .select('*')
    .in('id', businessIds)
    .order('created_at', { ascending: false });

  if (businessError) {
    mapDbError(businessError);
  }

  const { data: locations, error: locationError } = await client
    .from('business_locations')
    .select('*')
    .in('business_id', businessIds)
    .eq('is_primary', true);

  if (locationError) {
    mapDbError(locationError);
  }

  const roleByBusiness = new Map(memberships.map((row) => [row.business_id, row.role]));
  const primaryByBusiness = new Map(
    (locations ?? []).map((row) => [row.business_id, mapLocation(row)]),
  );

  return (businesses ?? []).map((row) => ({
    ...mapBusiness(row),
    role: roleByBusiness.get(row.id)!,
    primaryLocation: primaryByBusiness.get(row.id) ?? null,
  }));
}

export async function createBusinessAtomic(
  client: SupabaseClient,
  input: CreateBusinessInput,
): Promise<{
  business: Business;
  membership: BusinessMembership;
  primaryLocation: BusinessLocation;
  idempotentReplay: boolean;
}> {
  const { data, error } = await client.rpc('create_business_with_owner', {
    payload: toRpcPayload(input),
  });

  if (error) {
    mapDbError(error);
  }

  const payload = data as {
    business: Parameters<typeof mapBusiness>[0];
    membership: Parameters<typeof mapMembership>[0];
    primary_location: Parameters<typeof mapLocation>[0];
    idempotent_replay?: boolean;
  };

  return {
    business: mapBusiness(payload.business),
    membership: mapMembership(payload.membership),
    primaryLocation: mapLocation(payload.primary_location),
    idempotentReplay: Boolean(payload.idempotent_replay),
  };
}

export async function getBusinessForMember(
  client: SupabaseClient,
  businessId: string,
): Promise<Business | null> {
  const { data, error } = await client.from('businesses').select('*').eq('id', businessId).maybeSingle();
  if (error) {
    mapDbError(error);
  }
  return data ? mapBusiness(data) : null;
}

export async function updateBusinessForOwner(
  client: SupabaseClient,
  businessId: string,
  input: UpdateBusinessInput,
): Promise<Business> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.legalName !== undefined) patch.legal_name = input.legalName;
  if (input.description !== undefined) patch.description = input.description;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.websiteUrl !== undefined) patch.website_url = input.websiteUrl;
  if (input.logoUrl !== undefined) patch.logo_url = input.logoUrl || null;
  if (input.countryCode !== undefined) patch.country_code = input.countryCode;
  if (input.defaultCurrency !== undefined) patch.default_currency = input.defaultCurrency;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.defaultLocale !== undefined) patch.default_locale = input.defaultLocale;
  if (input.onboardingStatus !== undefined) patch.onboarding_status = input.onboardingStatus;

  const { data, error } = await client
    .from('businesses')
    .update(patch)
    .eq('id', businessId)
    .select('*')
    .maybeSingle();

  if (error) {
    mapDbError(error);
  }
  if (!data) {
    throw new BusinessServiceError('Business not found or not permitted', 'FORBIDDEN', 403);
  }

  return mapBusiness(data);
}

export async function listLocationsForMember(
  client: SupabaseClient,
  businessId: string,
): Promise<BusinessLocation[]> {
  const { data, error } = await client
    .from('business_locations')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true });

  if (error) {
    mapDbError(error);
  }

  return (data ?? []).map(mapLocation);
}

export async function createLocationForOwner(
  client: SupabaseClient,
  businessId: string,
  input: CreateLocationInput,
): Promise<BusinessLocation> {
  if (input.isPrimary) {
    const { error: clearError } = await client
      .from('business_locations')
      .update({ is_primary: false })
      .eq('business_id', businessId)
      .eq('is_primary', true);

    if (clearError) {
      mapDbError(clearError);
    }
  }

  const { data, error } = await client
    .from('business_locations')
    .insert({
      business_id: businessId,
      name: input.name,
      location_type: input.locationType,
      address_line_1: input.addressLine1 ?? null,
      address_line_2: input.addressLine2 ?? null,
      city: input.city,
      state_region: input.stateRegion ?? null,
      postal_code: input.postalCode ?? null,
      country_code: input.countryCode,
      phone: input.phone ?? null,
      email: input.email ?? null,
      timezone: input.timezone,
      is_primary: input.isPrimary,
      is_active: true,
    })
    .select('*')
    .single();

  if (error) {
    mapDbError(error);
  }

  return mapLocation(data);
}

export async function getOnboardingState(
  client: SupabaseClient,
  businessId: string,
): Promise<{ onboardingStatus: string; hasPrimaryLocation: boolean }> {
  const business = await getBusinessForMember(client, businessId);
  if (!business) {
    throw new BusinessServiceError('Business not found or not permitted', 'NOT_FOUND', 404);
  }

  const { data, error } = await client
    .from('business_locations')
    .select('id')
    .eq('business_id', businessId)
    .eq('is_primary', true)
    .maybeSingle();

  if (error) {
    mapDbError(error);
  }

  return {
    onboardingStatus: business.onboardingStatus,
    hasPrimaryLocation: Boolean(data),
  };
}

export async function getOnboardingDraft(
  client: SupabaseClient,
  userId: string,
): Promise<{ draft: Record<string, unknown>; updatedAt: string } | null> {
  const { data, error } = await client
    .from('business_onboarding_drafts')
    .select('draft, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    mapDbError(error);
  }

  if (!data) {
    return null;
  }

  return {
    draft: (data.draft ?? {}) as Record<string, unknown>,
    updatedAt: data.updated_at,
  };
}

export async function upsertOnboardingDraft(
  client: SupabaseClient,
  userId: string,
  draft: Record<string, unknown>,
): Promise<{ draft: Record<string, unknown>; updatedAt: string }> {
  const { data, error } = await client
    .from('business_onboarding_drafts')
    .upsert(
      {
        user_id: userId,
        draft,
      },
      { onConflict: 'user_id' },
    )
    .select('draft, updated_at')
    .single();

  if (error) {
    mapDbError(error);
  }

  return {
    draft: (data.draft ?? {}) as Record<string, unknown>,
    updatedAt: data.updated_at,
  };
}
