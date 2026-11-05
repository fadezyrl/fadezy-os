import type { NextFunction, Request, Response } from 'express';
import { API_ERROR_CODES } from '@fadezy/shared';
import {
  createUserScopedClient,
  getSupabaseAnonClient,
  isSupabaseConfigured,
} from '../config/supabase';
import { sendError } from '../utils/api-response';
import { mapProfileRow, mapSupabaseUser } from '../utils/auth-mappers';
import { logger } from '../utils/logger';

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return token.trim() || null;
}

/**
 * Verifies the caller with Supabase Auth using the supplied access token.
 * Does not trust body/query user ids. Does not decode JWTs locally as sole proof.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!isSupabaseConfigured()) {
      sendError(res, 503, {
        code: API_ERROR_CODES.SERVICE_UNAVAILABLE,
        message:
          'Authentication is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on the API.',
      });
      return;
    }

    const accessToken = extractBearerToken(req.headers.authorization);
    if (!accessToken) {
      sendError(res, 401, {
        code: API_ERROR_CODES.UNAUTHORIZED,
        message: 'Missing or invalid Authorization Bearer token',
      });
      return;
    }

    const supabase = getSupabaseAnonClient();
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      const message = error?.message?.toLowerCase() ?? '';
      const expired =
        message.includes('expired') ||
        message.includes('invalid jwt') ||
        error?.name === 'AuthApiError';

      sendError(res, 401, {
        code: API_ERROR_CODES.UNAUTHORIZED,
        message: expired
          ? 'Access token is invalid or expired'
          : 'Unable to verify authentication',
      });
      return;
    }

    const user = mapSupabaseUser(data.user);
    let profile = null;

    const userClient = createUserScopedClient(accessToken);
    const { data: profileRow, error: profileError } = await userClient
      .from('user_profiles')
      .select('id, full_name, avatar_url, created_at, updated_at')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) {
      // Profile table may not be migrated yet; auth still succeeds.
      logger.warn('Profile lookup failed during auth', {
        errorMessage: profileError.message,
      });
    } else if (profileRow) {
      profile = mapProfileRow(profileRow);
    }

    req.auth = {
      accessToken,
      user,
      profile,
    };

    next();
  } catch (error) {
    logger.error('Auth middleware failure', {
      errorMessage: error instanceof Error ? error.message : 'unknown',
    });
    sendError(res, 500, {
      code: API_ERROR_CODES.INTERNAL_ERROR,
      message: 'Authentication verification failed',
    });
  }
}
