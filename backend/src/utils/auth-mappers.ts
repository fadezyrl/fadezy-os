import type { User } from '@supabase/supabase-js';
import type { AuthenticatedUser, UserProfile } from '@fadezy/shared';

export function mapSupabaseUser(user: User): AuthenticatedUser {
  const fullNameMeta = user.user_metadata?.full_name;
  const fullName =
    typeof fullNameMeta === 'string' && fullNameMeta.trim().length > 0
      ? fullNameMeta.trim()
      : null;

  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    fullName,
    phone: user.phone ?? null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
  };
}

export function mapProfileRow(row: {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}): UserProfile {
  return {
    id: row.id,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
