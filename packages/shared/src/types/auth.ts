/**
 * Shared authentication contracts for web, mobile, and API clients.
 * Identity source of truth: Supabase Auth (auth.users).
 */

export type AuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'loading'
  | 'email_unverified';

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  fullName: string | null;
  phone: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface UserProfile {
  id: string;
  fullName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  user: AuthenticatedUser;
}

export interface AuthError {
  code: string;
  message: string;
}

export interface AuthMeData {
  user: AuthenticatedUser;
  profile: UserProfile | null;
}

export interface AuthVerifyData {
  valid: true;
  userId: string;
  email: string | null;
}

/**
 * Future RBAC foundation only — not granted by auth alone.
 * Never elevate roles from client-editable user metadata.
 */
export type FuturePlatformRole =
  | 'platform_admin'
  | 'business_owner'
  | 'business_manager'
  | 'staff'
  | 'customer';
