import type { Response } from 'express';
import type { ApiErrorBody, ApiSuccessResponse } from '@fadezy/shared';

export function sendSuccess<T>(
  res: Response,
  data: T,
  options?: { status?: number; message?: string },
): Response {
  const body: ApiSuccessResponse<T> = {
    success: true,
    data,
    ...(options?.message ? { message: options.message } : {}),
  };
  return res.status(options?.status ?? 200).json(body);
}

export function sendError(
  res: Response,
  status: number,
  error: ApiErrorBody,
): Response {
  return res.status(status).json({
    success: false,
    error,
  });
}
