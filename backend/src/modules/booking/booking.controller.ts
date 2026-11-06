import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  bookingListQuerySchema,
  bookingSlotsQuerySchema,
  cancelBookingInputSchema,
  createBookingInputSchema,
  guestCreateBookingInputSchema,
  guestSlotsQuerySchema,
  rescheduleBookingInputSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  BookingServiceError,
  createBooking,
  createGuestBooking,
  getBooking,
  getBookingPermissions,
  listBookings,
  listGuestSlots,
  listSlots,
  rescheduleBooking,
  transitionBooking,
} from './booking.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof BookingServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Booking operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected booking operation failure',
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

export async function bookingPermissionsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getBookingPermissions(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function listSlotsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = bookingSlotsQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await listSlots(client, businessId, parsed.data, { userId: auth.user.id }),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function listBookingsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = bookingListQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listBookings(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createBookingInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createBooking(client, businessId, auth.user.id, parsed.data), {
      status: 201,
    });
  } catch (error) {
    handleError(res, error);
  }
}

export async function getBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const bookingId = z.string().uuid().safeParse(req.params.bookingId);
  if (!bookingId.success) {
    sendError(res, 422, { code: API_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid booking id' });
    return;
  }
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getBooking(client, businessId, auth.user.id, bookingId.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function cancelBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const bookingId = z.string().uuid().safeParse(req.params.bookingId);
  if (!bookingId.success) {
    sendError(res, 422, { code: API_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid booking id' });
    return;
  }
  const parsed = cancelBookingInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await transitionBooking(
        client,
        businessId,
        auth.user.id,
        bookingId.data,
        'cancelled',
        parsed.data.reason,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function completeBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const bookingId = z.string().uuid().safeParse(req.params.bookingId);
  if (!bookingId.success) {
    sendError(res, 422, { code: API_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid booking id' });
    return;
  }
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await transitionBooking(client, businessId, auth.user.id, bookingId.data, 'completed'),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function noShowBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const bookingId = z.string().uuid().safeParse(req.params.bookingId);
  if (!bookingId.success) {
    sendError(res, 422, { code: API_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid booking id' });
    return;
  }
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await transitionBooking(client, businessId, auth.user.id, bookingId.data, 'no_show'),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function rescheduleBookingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const bookingId = z.string().uuid().safeParse(req.params.bookingId);
  if (!bookingId.success) {
    sendError(res, 422, { code: API_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid booking id' });
    return;
  }
  const parsed = rescheduleBookingInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await rescheduleBooking(client, businessId, auth.user.id, bookingId.data, parsed.data.startsAt),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function guestSlotsHandler(req: Request, res: Response): Promise<void> {
  const parsed = guestSlotsQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const { businessSlug, ...query } = parsed.data;
    sendSuccess(res, await listGuestSlots(businessSlug, query));
  } catch (error) {
    handleError(res, error);
  }
}

export async function guestCreateBookingHandler(req: Request, res: Response): Promise<void> {
  const parsed = guestCreateBookingInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const { businessSlug, ...body } = parsed.data;
    sendSuccess(res, await createGuestBooking(businessSlug, body), { status: 201 });
  } catch (error) {
    handleError(res, error);
  }
}
