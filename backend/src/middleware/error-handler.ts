import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError } from '../utils/api-response';
import { logger } from '../utils/logger';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    sendError(res, 422, {
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unexpected server error';
  logger.error('Unhandled request error', {
    errorName: err instanceof Error ? err.name : 'UnknownError',
    errorMessage: message,
  });

  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
  });
}
