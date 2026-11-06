import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  customerBookingsQuerySchema,
  customerInputSchema,
  customerListQuerySchema,
  customerUpdateSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  CustomerServiceError,
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomerBookings,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from './customers.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof CustomerServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Customer operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected customer operation failure',
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

function customerIdParam(req: Request, res: Response): string | null {
  const parsed = z.string().uuid().safeParse(req.params.customerId);
  if (!parsed.success) {
    sendError(res, 422, {
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: 'Invalid customer id',
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

export async function listCustomersHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = customerListQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listCustomers(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createCustomerHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = customerInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createCustomer(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function getCustomerHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const customerId = customerIdParam(req, res);
  if (!auth || !businessId || !customerId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getCustomer(client, businessId, auth.user.id, customerId));
  } catch (error) {
    handleError(res, error);
  }
}

export async function updateCustomerHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const customerId = customerIdParam(req, res);
  if (!auth || !businessId || !customerId) return;
  const parsed = customerUpdateSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateCustomer(client, businessId, auth.user.id, customerId, parsed.data),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function archiveCustomerHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const customerId = customerIdParam(req, res);
  if (!auth || !businessId || !customerId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await archiveCustomer(client, businessId, auth.user.id, customerId), {
      message: 'Customer archived',
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function restoreCustomerHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const customerId = customerIdParam(req, res);
  if (!auth || !businessId || !customerId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await restoreCustomer(client, businessId, auth.user.id, customerId), {
      message: 'Customer restored',
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function listCustomerBookingsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const customerId = customerIdParam(req, res);
  if (!auth || !businessId || !customerId) return;
  const parsed = customerBookingsQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await listCustomerBookings(client, businessId, auth.user.id, customerId, parsed.data),
    );
  } catch (error) {
    handleError(res, error);
  }
}
