/**
 * International SaaS foundations.
 * Prefer ISO / IANA identifiers. Do not hardcode a single country, currency, language, or timezone.
 */

/** ISO 3166-1 alpha-2 country code (e.g. "US", "GB", "AE"). */
export type CountryCode = string;

/** ISO 4217 currency code (e.g. "USD", "EUR", "AED"). */
export type CurrencyCode = string;

/** BCP 47 language / locale tag (e.g. "en-US", "ar-AE", "pt-BR"). */
export type LocaleTag = string;

/** IANA time zone identifier (e.g. "America/New_York", "Asia/Dubai"). */
export type TimeZoneId = string;

/** E.164-compatible phone number string (e.g. "+14155552671"). */
export type E164PhoneNumber = string;

/**
 * Tenant-scoped business profile placeholders for future multi-location support.
 * No business tables are created in Phase 01 — these are shared contracts only.
 */
export interface BusinessLocalePreferences {
  defaultLocale: LocaleTag;
  supportedLocales: LocaleTag[];
  defaultCurrency: CurrencyCode;
  defaultTimeZone: TimeZoneId;
  defaultCountry: CountryCode;
}

export interface BusinessLocationRef {
  id: string;
  businessId: string;
  countryCode: CountryCode;
  timeZone: TimeZoneId;
  currencyCode: CurrencyCode;
}
