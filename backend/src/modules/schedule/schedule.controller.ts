import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  availabilityContextQuerySchema,
  createTimeOffInputSchema,
  putLocationHoursInputSchema,
  putStaffScheduleInputSchema,
  putWeeklyHoursInputSchema,
  scheduleExceptionInputSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  ScheduleServiceError,
  cancelException,
  cancelTimeOff,
  createException,
  createTimeOff,
  getAvailabilityContext,
  getBusinessHours,
  getLocationHours,
  getSchedulePermissions,
  listExceptions,
  listStaffSchedules,
  listTimeOff,
  putBusinessHours,
  putLocationHours,
  putStaffSchedule,
  reviewTimeOff,
} from './schedule.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ScheduleServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Schedule operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected schedule operation failure',
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

function validationError(res: Response, issues: z.ZodIssue[]) {
  sendError(res, 422, {
    code: API_ERROR_CODES.VALIDATION_ERROR,
    message: 'Request validation failed',
    details: issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

export async function permissionsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getSchedulePermissions(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getBusinessHoursHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getBusinessHours(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function putBusinessHoursHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = putWeeklyHoursInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await putBusinessHours(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getLocationHoursHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await getLocationHours(client, businessId, auth.user.id, String(req.params.locationId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function putLocationHoursHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = putLocationHoursInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await putLocationHours(
        client,
        businessId,
        auth.user.id,
        String(req.params.locationId),
        parsed.data,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function listExceptionsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    const locationId =
      typeof req.query.locationId === 'string' ? req.query.locationId : undefined;
    sendSuccess(res, await listExceptions(client, businessId, auth.user.id, locationId));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createExceptionHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = scheduleExceptionInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createException(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function cancelExceptionHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await cancelException(client, businessId, auth.user.id, String(req.params.exceptionId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function listStaffSchedulesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await listStaffSchedules(client, businessId, auth.user.id, String(req.params.memberId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function putStaffScheduleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = putStaffScheduleInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await putStaffSchedule(
        client,
        businessId,
        auth.user.id,
        String(req.params.memberId),
        parsed.data,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function listTimeOffHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listTimeOff(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createTimeOffHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createTimeOffInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createTimeOff(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function approveTimeOffHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await reviewTimeOff(client, businessId, auth.user.id, String(req.params.timeOffId), 'approve'),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function rejectTimeOffHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await reviewTimeOff(client, businessId, auth.user.id, String(req.params.timeOffId), 'reject'),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function cancelTimeOffHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await cancelTimeOff(client, businessId, auth.user.id, String(req.params.timeOffId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function availabilityContextHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = availabilityContextQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getAvailabilityContext(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}
