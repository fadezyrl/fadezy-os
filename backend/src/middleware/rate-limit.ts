import type { NextFunction, Request, Response } from 'express';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError } from '../utils/api-response';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Lightweight in-memory rate limiter for auth endpoints.
 * Suitable for a single API instance; replace with shared store when scaling horizontally.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${identity}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (existing.count >= options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      sendError(res, 429, {
        code: API_ERROR_CODES.FORBIDDEN,
        message: 'Too many requests. Try again later.',
      });
      return;
    }

    existing.count += 1;
    next();
  };
}
