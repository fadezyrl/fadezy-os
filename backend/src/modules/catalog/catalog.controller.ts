import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  catalogListQuerySchema,
  createServiceAddonInputSchema,
  createServiceCategoryInputSchema,
  createServiceInputSchema,
  reorderItemsInputSchema,
  setServiceAddonsInputSchema,
  updateServiceAddonInputSchema,
  updateServiceCategoryInputSchema,
  updateServiceInputSchema,
  upsertServiceLocationSettingsInputSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  CatalogServiceError,
  archiveAddon,
  archiveCategory,
  archiveService,
  createAddon,
  createCategory,
  createService,
  getCategory,
  getService,
  listAddons,
  listCategories,
  listServices,
  reorderCategories,
  reorderServices,
  setServiceAddons,
  updateAddon,
  updateCategory,
  updateService,
  upsertLocationSettings,
} from './catalog.service';

function handleServiceError(res: Response, error: unknown): void {
  if (error instanceof CatalogServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Catalog operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected catalog operation failure',
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

const archiveCategoryBodySchema = z.object({
  reassignServicesToCategoryId: z.string().uuid().nullable().optional(),
  forceWithServices: z.boolean().optional(),
});

export async function listCategoriesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listCategories(client, businessId, includeArchived));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function createCategoryHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createServiceCategoryInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createCategory(client, businessId, parsed.data), { status: 201 });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function getCategoryHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getCategory(client, businessId, String(req.params.categoryId)));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function updateCategoryHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateServiceCategoryInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateCategory(client, businessId, String(req.params.categoryId), parsed.data),
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function archiveCategoryHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = archiveCategoryBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await archiveCategory(client, businessId, String(req.params.categoryId), parsed.data),
      { message: 'Category archived' },
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function reorderCategoriesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = reorderItemsInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await reorderCategories(client, businessId, parsed.data));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function listServicesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = catalogListQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listServices(client, businessId, parsed.data));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function createServiceHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createServiceInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createService(client, businessId, parsed.data), { status: 201 });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function getServiceHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getService(client, businessId, String(req.params.serviceId)));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function updateServiceHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateServiceInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateService(client, businessId, String(req.params.serviceId), parsed.data),
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function archiveServiceHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await archiveService(client, businessId, String(req.params.serviceId)), {
      message: 'Service archived',
    });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function reorderServicesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = reorderItemsInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    await reorderServices(client, businessId, parsed.data);
    sendSuccess(res, { reordered: true });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function upsertLocationSettingsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = upsertServiceLocationSettingsInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await upsertLocationSettings(client, businessId, String(req.params.serviceId), parsed.data),
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function setServiceAddonsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = setServiceAddonsInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await setServiceAddons(client, businessId, String(req.params.serviceId), parsed.data),
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function listAddonsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listAddons(client, businessId, includeArchived));
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function createAddonHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createServiceAddonInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await createAddon(client, businessId, parsed.data), { status: 201 });
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function updateAddonHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateServiceAddonInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateAddon(client, businessId, String(req.params.addonId), parsed.data),
    );
  } catch (error) {
    handleServiceError(res, error);
  }
}

export async function archiveAddonHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await archiveAddon(client, businessId, String(req.params.addonId)), {
      message: 'Add-on archived',
    });
  } catch (error) {
    handleServiceError(res, error);
  }
}
