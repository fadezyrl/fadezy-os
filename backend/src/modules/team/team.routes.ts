import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  acceptInvitationHandler,
  cancelInvitationHandler,
  createInvitationHandler,
  getMemberHandler,
  getPermissionsHandler,
  listInvitationsHandler,
  listMembersHandler,
  resendInvitationHandler,
  setLocationsHandler,
  setServicesHandler,
  updateProfileHandler,
  updateRoleHandler,
  updateStatusHandler,
} from './team.controller';

/** Mounted on businesses router (auth already applied). */
const teamRouter = Router({ mergeParams: true });

teamRouter.get('/:businessId/members', asyncHandler(listMembersHandler));
teamRouter.get('/:businessId/members/permissions', asyncHandler(getPermissionsHandler));
teamRouter.get('/:businessId/members/:memberId', asyncHandler(getMemberHandler));
teamRouter.patch('/:businessId/members/:memberId/profile', asyncHandler(updateProfileHandler));
teamRouter.patch('/:businessId/members/:memberId/role', asyncHandler(updateRoleHandler));
teamRouter.patch('/:businessId/members/:memberId/status', asyncHandler(updateStatusHandler));
teamRouter.put('/:businessId/members/:memberId/locations', asyncHandler(setLocationsHandler));
teamRouter.put('/:businessId/members/:memberId/services', asyncHandler(setServicesHandler));

teamRouter.get('/:businessId/invitations', asyncHandler(listInvitationsHandler));
teamRouter.post('/:businessId/invitations', asyncHandler(createInvitationHandler));
teamRouter.post(
  '/:businessId/invitations/:invitationId/cancel',
  asyncHandler(cancelInvitationHandler),
);
teamRouter.post(
  '/:businessId/invitations/:invitationId/resend',
  asyncHandler(resendInvitationHandler),
);

export { teamRouter };

/** Accept is not business-scoped in the URL. */
const invitationAcceptRouter = Router();
invitationAcceptRouter.post('/accept', asyncHandler(acceptInvitationHandler));

export { invitationAcceptRouter };
