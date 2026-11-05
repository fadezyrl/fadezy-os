/**
 * Extensible international defaults.
 * These are empty catalogs / patterns — not product defaults locked to one market.
 */

/** Pattern hint for validating BCP 47-ish locale tags at the boundary layer. */
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]+)*$/;

/** Pattern hint for ISO 4217 currency codes. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Pattern hint for ISO 3166-1 alpha-2 country codes. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Role names are intentionally open-ended for future RBAC.
 * Concrete permission matrices belong in later phases.
 */
export const PLATFORM_ROLE_KEYS = [
  'platform_admin',
  'business_owner',
  'location_manager',
  'staff',
  'receptionist',
  'customer',
] as const;

export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];
