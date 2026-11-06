import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  checkoutBookingSaleSchema,
  closeRegisterSessionSchema,
  createWalkInSaleSchema,
  dailySummaryQuerySchema,
  openRegisterSessionSchema,
  recordSalePaymentSchema,
  refundSalePaymentSchema,
  registerCashAdjustmentSchema,
  saleListQuerySchema,
  taxSettingsUpdateSchema,
  updateOpenSaleSchema,
  voidSaleSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  PosServiceError,
  adjustRegisterCash,
  checkoutBookingSale,
  closeRegister,
  createWalkInSale,
  getDailySummary,
  getOpenRegister,
  getPosPermissions,
  getRegisterSession,
  getSale,
  getSaleByBooking,
  getTaxSettings,
  listSales,
  openRegister,
  recordPayment,
  refundPayment,
  updateOpenSale,
  updateTaxSettings,
  voidSale,
} from './pos.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof PosServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('POS operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected POS operation failure',
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

function uuidParam(req: Request, res: Response, name: string): string | null {
  const parsed = z.string().uuid().safeParse(req.params[name]);
  if (!parsed.success) {
    sendError(res, 422, {
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `Invalid ${name}`,
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

export async function posPermissionsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getPosPermissions(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getTaxSettingsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getTaxSettings(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function updateTaxSettingsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = taxSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await updateTaxSettings(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createWalkInSaleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createWalkInSaleSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createWalkInSale(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function checkoutBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = checkoutBookingSaleSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await checkoutBookingSale(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function listSalesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = saleListQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listSales(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getSaleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const saleId = uuidParam(req, res, 'saleId');
  if (!auth || !businessId || !saleId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getSale(client, businessId, auth.user.id, saleId));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getSaleByBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const bookingId = uuidParam(req, res, 'bookingId');
  if (!auth || !businessId || !bookingId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    const sale = await getSaleByBooking(client, businessId, auth.user.id, bookingId);
    if (!sale) {
      sendError(res, 404, { code: API_ERROR_CODES.NOT_FOUND, message: 'Sale not found' });
      return;
    }
    sendSuccess(res, sale);
  } catch (error) {
    handleError(res, error);
  }
}

export async function updateOpenSaleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const saleId = uuidParam(req, res, 'saleId');
  if (!auth || !businessId || !saleId) return;
  const parsed = updateOpenSaleSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await updateOpenSale(client, businessId, auth.user.id, saleId, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function recordPaymentHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const saleId = uuidParam(req, res, 'saleId');
  if (!auth || !businessId || !saleId) return;
  const parsed = recordSalePaymentSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await recordPayment(client, businessId, auth.user.id, saleId, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function refundPaymentHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const saleId = uuidParam(req, res, 'saleId');
  const paymentId = uuidParam(req, res, 'paymentId');
  if (!auth || !businessId || !saleId || !paymentId) return;
  const parsed = refundSalePaymentSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await refundPayment(client, businessId, auth.user.id, saleId, paymentId, parsed.data),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function voidSaleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const saleId = uuidParam(req, res, 'saleId');
  if (!auth || !businessId || !saleId) return;
  const parsed = voidSaleSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await voidSale(client, businessId, auth.user.id, saleId, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function dailySummaryHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = dailySummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await getDailySummary(
        client,
        businessId,
        auth.user.id,
        parsed.data.date,
        parsed.data.locationId,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function openRegisterHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = openRegisterSessionSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await openRegister(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function getOpenRegisterHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const locationId = z.string().uuid().safeParse(req.query.locationId);
  if (!locationId.success) {
    sendError(res, 422, {
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: 'locationId is required',
    });
    return;
  }
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getOpenRegister(client, businessId, auth.user.id, locationId.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getRegisterSessionHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const sessionId = uuidParam(req, res, 'sessionId');
  if (!auth || !businessId || !sessionId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getRegisterSession(client, businessId, auth.user.id, sessionId));
  } catch (error) {
    handleError(res, error);
  }
}

export async function closeRegisterHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const sessionId = uuidParam(req, res, 'sessionId');
  if (!auth || !businessId || !sessionId) return;
  const parsed = closeRegisterSessionSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await closeRegister(client, businessId, auth.user.id, sessionId, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function adjustRegisterHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  const sessionId = uuidParam(req, res, 'sessionId');
  if (!auth || !businessId || !sessionId) return;
  const parsed = registerCashAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await adjustRegisterCash(client, businessId, auth.user.id, sessionId, parsed.data),
    );
  } catch (error) {
    handleError(res, error);
  }
}
