import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  createBusinessInputSchema,
  createLocationInputSchema,
  onboardingDraftSchema,
  updateBusinessInputSchema,
} from '@fadezy/shared';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  BusinessServiceError,
  createBusinessAtomic,
  createLocationForOwner,
  getBusinessForMember,
  getOnboardingDraft,
  getOnboardingState,
  listAccessibleBusinesses,
  listLocationsForMember,
  updateBusinessForOwner,
  upsertOnboardingDraft,
} from './business.service';

function handleServiceError(res: Response, error: unknown): void {
  if (error instanceof BusinessServiceError) {
    sendError(res, error.status, {
      code: error.code,
      message: error.message,
    });
    return;
  }

  logger.error('Business operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected business operation failure',
  });
}

function requireAuthContext(req: Request, res: Response) {
  if (!req.auth) {
    sendError(res, 401, {
      code: API_ERROR_CODES.UNAUTHORIZED,
      message: 'Authentication required',
    });
    return null;
  }
  return req.auth;
}

export async function listBusinessesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  try {
    const client = createUserScopedClient(auth.accessToken);
    const data = await listAccessibleBusinesses(client, auth.user.id);
    sendSuccess(res, data);
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function createBusinessHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const parsed = createBusinessInputSchema.safeParse(req.body);
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

  try {
    const client = createUserScopedClient(auth.accessToken);
    const result = await createBusinessAtomic(client, parsed.data);
    sendSuccess(res, result, {
      status: result.idempotentReplay ? 200 : 201,
      message: result.idempotentReplay
        ? 'Idempotent replay of an existing business creation request'
        : 'Business created',
    });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function getBusinessHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const businessId = String(req.params.businessId ?? '');
  try {
    const client = createUserScopedClient(auth.accessToken);
    const business = await getBusinessForMember(client, businessId);
    if (!business) {
      sendError(res, 404, {
        code: API_ERROR_CODES.NOT_FOUND,
        message: 'Business not found',
      });
      return;
    }
    sendSuccess(res, business);
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function updateBusinessHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const parsed = updateBusinessInputSchema.safeParse(req.body);
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

  const businessId = String(req.params.businessId ?? '');
  try {
    const client = createUserScopedClient(auth.accessToken);
    const business = await updateBusinessForOwner(client, businessId, parsed.data);
    sendSuccess(res, business, { message: 'Business updated' });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function listLocationsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const businessId = String(req.params.businessId ?? '');
  try {
    const client = createUserScopedClient(auth.accessToken);
    const business = await getBusinessForMember(client, businessId);
    if (!business) {
      sendError(res, 404, {
        code: API_ERROR_CODES.NOT_FOUND,
        message: 'Business not found',
      });
      return;
    }
    const locations = await listLocationsForMember(client, businessId);
    sendSuccess(res, locations);
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function createLocationHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const parsed = createLocationInputSchema.safeParse(req.body);
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

  const businessId = String(req.params.businessId ?? '');
  try {
    const client = createUserScopedClient(auth.accessToken);
    const location = await createLocationForOwner(client, businessId, parsed.data);
    sendSuccess(res, location, { status: 201, message: 'Location created' });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function getBusinessOnboardingHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const businessId = String(req.params.businessId ?? '');
  try {
    const client = createUserScopedClient(auth.accessToken);
    const data = await getOnboardingState(client, businessId);
    sendSuccess(res, data);
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function getDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  try {
    const client = createUserScopedClient(auth.accessToken);
    const draft = await getOnboardingDraft(client, auth.user.id);
    sendSuccess(res, draft);
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function putDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  if (!auth) return;

  const parsed = onboardingDraftSchema.safeParse(req.body);
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

  try {
    const client = createUserScopedClient(auth.accessToken);
    const draft = await upsertOnboardingDraft(client, auth.user.id, parsed.data.draft);
    sendSuccess(res, draft, { message: 'Onboarding draft saved' });
  } catch (error) {
    handleServiceError(res, error);
  }
}
