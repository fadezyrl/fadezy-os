import type { Request, Response } from 'express';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError } from '../utils/api-response';

export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 404, {
    code: API_ERROR_CODES.NOT_FOUND,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}
