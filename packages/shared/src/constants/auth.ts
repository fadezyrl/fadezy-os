export const AUTH_ERROR_CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_CONFIRMED: 'EMAIL_NOT_CONFIRMED',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EXPIRED_TOKEN: 'EXPIRED_TOKEN',
  SESSION_REVOKED: 'SESSION_REVOKED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** Safe relative paths used after auth redirects (open-redirect protection). */
export const SAFE_AUTH_REDIRECTS = [
  '/app',
  '/verify-email',
  '/reset-password',
  '/login',
  '/register',
  '/onboarding',
  '/workspace',
  '/invite',
] as const;
