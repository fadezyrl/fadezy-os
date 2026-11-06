import type { Request, Response } from 'express';
import { API_ERROR_CODES, insightsOverviewQuerySchema } from '@fadezy/shared';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import { InsightsServiceError, getWorkspaceOverview } from './insights.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof InsightsServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Insights operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unable to load workspace insights',
  });
}

export async function getWorkspaceOverviewHandler(req: Request, res: Response): Promise<void> {
  try {
    const auth = req.auth;
    if (!auth?.accessToken || !auth.user?.id) {
      sendError(res, 401, {
        code: API_ERROR_CODES.UNAUTHORIZED,
        message: 'Authentication required',
      });
      return;
    }
    const businessId = String(req.params.businessId ?? '');
    const parsed = insightsOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: parsed.error.issues[0]?.message ?? 'Invalid insights query',
      });
      return;
    }
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getWorkspaceOverview(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}
