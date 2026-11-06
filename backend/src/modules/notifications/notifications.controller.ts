import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  markNotificationReadSchema,
  notificationListQuerySchema,
  notificationPreferenceUpdateSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  NotificationServiceError,
  listInAppNotifications,
  listNotificationPreferences,
  markInAppNotificationRead,
  updateNotificationPreferences,
} from './notifications.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof NotificationServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Notification operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected notification failure',
  });
}

function requireAuth(req: Request, res: Response) {
  if (!req.auth) {
    sendError(res, 401, {
      code: API_ERROR_CODES.UNAUTHORIZED,
      message: 'Authentication required',
    });
    return null;
  }
  return req.auth;
}

function businessIdParam(req: Request, res: Response): string | null {
  const parsed = z.string().uuid().safeParse(req.params.businessId);
  if (!parsed.success) {
    sendError(res, 422, {
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: 'Invalid business id',
    });
    return null;
  }
  return parsed.data;
}

export async function listNotificationsHandler(req: Request, res: Response): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const businessId = businessIdParam(req, res);
    if (!businessId) return;
    const query = notificationListQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid query',
      });
      return;
    }
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listInAppNotifications(client, businessId, auth.user.id, query.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function markNotificationReadHandler(req: Request, res: Response): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const businessId = businessIdParam(req, res);
    if (!businessId) return;
    const id = z.string().uuid().safeParse(req.params.notificationId);
    if (!id.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid notification id',
      });
      return;
    }
    const body = markNotificationReadSchema.safeParse(req.body ?? {});
    if (!body.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid body',
      });
      return;
    }
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await markInAppNotificationRead(
        client,
        businessId,
        auth.user.id,
        id.data,
        body.data.read !== false,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function listNotificationPreferencesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const businessId = businessIdParam(req, res);
    if (!businessId) return;
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listNotificationPreferences(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function updateNotificationPreferencesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const businessId = businessIdParam(req, res);
    if (!businessId) return;
    const body = notificationPreferenceUpdateSchema.safeParse(req.body);
    if (!body.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid preferences payload',
      });
      return;
    }
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateNotificationPreferences(client, businessId, auth.user.id, body.data),
    );
  } catch (error) {
    handleError(res, error);
  }
}
