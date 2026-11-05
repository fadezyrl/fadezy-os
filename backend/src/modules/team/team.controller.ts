import type { Request, Response } from 'express';
import {
  API_ERROR_CODES,
  acceptInvitationInputSchema,
  createInvitationInputSchema,
  setMemberLocationsInputSchema,
  setMemberServicesInputSchema,
  teamListQuerySchema,
  updateMemberRoleInputSchema,
  updateMemberStatusInputSchema,
  updateStaffProfileInputSchema,
} from '@fadezy/shared';
import { z } from 'zod';
import { createUserScopedClient } from '../../config/supabase';
import { sendError, sendSuccess } from '../../utils/api-response';
import { logger } from '../../utils/logger';
import {
  TeamServiceError,
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  getMyTeamPermissions,
  getTeamMember,
  listInvitations,
  listTeamMembers,
  resendInvitation,
  setMemberLocations,
  setMemberServices,
  updateMemberRole,
  updateMemberStatus,
  updateStaffProfile,
} from './team.service';

function handleError(res: Response, error: unknown): void {
  if (error instanceof TeamServiceError) {
    sendError(res, error.status, { code: error.code, message: error.message });
    return;
  }
  logger.error('Team operation failed', {
    errorMessage: error instanceof Error ? error.message : 'unknown',
  });
  sendError(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: 'Unexpected team operation failure',
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

export async function listMembersHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = teamListQuerySchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listTeamMembers(client, businessId, auth.user.id, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function getMemberHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await getTeamMember(client, businessId, auth.user.id, String(req.params.memberId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function getPermissionsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await getMyTeamPermissions(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function createInvitationHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = createInvitationInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    const { data: business } = await client
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle();
    const result = await createInvitation(client, businessId, auth.user.id, parsed.data, {
      businessName: business?.name ?? 'your business',
      inviterLabel: auth.profile?.fullName || auth.user.email || 'A teammate',
    });
    sendSuccess(res, result, { status: 201 });
  } catch (error) {
    handleError(res, error);
  }
}

export async function listInvitationsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await listInvitations(client, businessId, auth.user.id));
  } catch (error) {
    handleError(res, error);
  }
}

export async function cancelInvitationHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await cancelInvitation(client, businessId, auth.user.id, String(req.params.invitationId)),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function resendInvitationHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  try {
    const client = createUserScopedClient(auth.accessToken);
    const { data: business } = await client
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle();
    sendSuccess(
      res,
      await resendInvitation(client, businessId, auth.user.id, String(req.params.invitationId), {
        businessName: business?.name ?? 'your business',
        inviterLabel: auth.profile?.fullName || auth.user.email || 'A teammate',
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
}

export async function acceptInvitationHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const parsed = acceptInvitationInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(res, await acceptInvitation(client, parsed.data));
  } catch (error) {
    handleError(res, error);
  }
}

export async function updateProfileHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateStaffProfileInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateStaffProfile(
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

export async function updateRoleHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateMemberRoleInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateMemberRole(
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

export async function updateStatusHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = updateMemberStatusInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await updateMemberStatus(
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

export async function setLocationsHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = setMemberLocationsInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await setMemberLocations(
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

export async function setServicesHandler(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req, res);
  const businessId = businessIdParam(req, res);
  if (!auth || !businessId) return;
  const parsed = setMemberServicesInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  try {
    const client = createUserScopedClient(auth.accessToken);
    sendSuccess(
      res,
      await setMemberServices(
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
