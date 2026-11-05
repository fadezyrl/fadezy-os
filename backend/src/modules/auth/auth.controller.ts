import type { Request, Response } from 'express';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError, sendSuccess } from '../../utils/api-response';

export function authMeHandler(req: Request, res: Response): void {
  if (!req.auth) {
    sendError(res, 401, {
      code: API_ERROR_CODES.UNAUTHORIZED,
      message: 'Authentication required',
    });
    return;
  }

  sendSuccess(res, {
    user: req.auth.user,
    profile: req.auth.profile,
  });
}

export function authVerifyHandler(req: Request, res: Response): void {
  if (!req.auth) {
    sendError(res, 401, {
      code: API_ERROR_CODES.UNAUTHORIZED,
      message: 'Authentication required',
    });
    return;
  }

  sendSuccess(res, {
    valid: true as const,
    userId: req.auth.user.id,
    email: req.auth.user.email,
  });
}
