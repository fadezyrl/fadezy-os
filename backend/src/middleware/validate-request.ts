import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError } from '../utils/api-response';

type RequestTarget = 'body' | 'query' | 'params';

export function validateRequest(schema: ZodType, target: RequestTarget = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[target]);

    if (!parsed.success) {
      sendError(res, 422, {
        code: API_ERROR_CODES.VALIDATION_ERROR,
        message: 'Request validation failed',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    req[target] = parsed.data as typeof req[typeof target];
    next();
  };
}
