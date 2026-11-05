import type { Request, Response } from 'express';
import { API_ERROR_CODES } from '@fadezy/shared';
import { sendError, sendSuccess } from '../../utils/api-response';
import { getHealthStatus, getReadinessStatus } from './health.service';

export function healthHandler(_req: Request, res: Response): void {
  sendSuccess(res, getHealthStatus());
}

export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const data = await getReadinessStatus();

  if (data.status !== 'ready') {
    sendError(res, 503, {
      code: API_ERROR_CODES.NOT_READY,
      message: 'Service is not ready',
      details: data,
    });
    return;
  }

  sendSuccess(res, data);
}
