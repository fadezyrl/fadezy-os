import type { BusinessType } from '../types/business';

export const BUSINESS_TYPE_META: Record<
  BusinessType,
  { title: string; description: string; accent: string }
> = {
  barbershop: {
    title: 'Barbershop',
    description: 'Cuts, fades, grooming, and classic barber services.',
    accent: '#134c3f',
  },
  beauty_salon: {
    title: 'Beauty Salon',
    description: 'Hair, beauty, and salon experiences for every guest.',
    accent: '#5b4636',
  },
};

/**
 * Curated international defaults for onboarding suggestions.
 * Not locked to a single market — users can change every field.
 */
export const COUNTRY_OPTIONS = [
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', timezone: 'Asia/Dubai', locale: 'en-AE' },
  { code: 'AU', name: 'Australia', currency: 'AUD', timezone: 'Australia/Sydney', locale: 'en-AU' },
  { code: 'BR', name: 'Brazil', currency: 'BRL', timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
  { code: 'CA', name: 'Canada', currency: 'CAD', timezone: 'America/Toronto', locale: 'en-CA' },
  { code: 'DE', name: 'Germany', currency: 'EUR', timezone: 'Europe/Berlin', locale: 'de-DE' },
  { code: 'ES', name: 'Spain', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es-ES' },
  { code: 'FR', name: 'France', currency: 'EUR', timezone: 'Europe/Paris', locale: 'fr-FR' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', timezone: 'Europe/London', locale: 'en-GB' },
  { code: 'IN', name: 'India', currency: 'INR', timezone: 'Asia/Kolkata', locale: 'en-IN' },
  { code: 'PK', name: 'Pakistan', currency: 'PKR', timezone: 'Asia/Karachi', locale: 'en-PK' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', timezone: 'Asia/Riyadh', locale: 'ar-SA' },
  { code: 'TR', name: 'Türkiye', currency: 'TRY', timezone: 'Europe/Istanbul', locale: 'tr-TR' },
  { code: 'US', name: 'United States', currency: 'USD', timezone: 'America/New_York', locale: 'en-US' },
] as const;

export const CURRENCY_OPTIONS = [
  'AED',
  'AUD',
  'BRL',
  'CAD',
  'EUR',
  'GBP',
  'INR',
  'PKR',
  'SAR',
  'TRY',
  'USD',
] as const;

export const LOCALE_OPTIONS = [
  'ar-AE',
  'ar-SA',
  'de-DE',
  'en-AE',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-IN',
  'en-PK',
  'en-US',
  'es-ES',
  'fr-FR',
  'pt-BR',
  'tr-TR',
] as const;

export const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Riyadh',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'UTC',
] as const;
