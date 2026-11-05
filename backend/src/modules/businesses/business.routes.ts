import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth';
import { asyncHandler } from '../../utils/async-handler';
import { catalogRouter } from '../catalog/catalog.routes';
import { scheduleRouter } from '../schedule/schedule.routes';
import { teamRouter } from '../team/team.routes';
import {
  createBusinessHandler,
  createLocationHandler,
  getBusinessHandler,
  getBusinessOnboardingHandler,
  getDraftHandler,
  listBusinessesHandler,
  listLocationsHandler,
  putDraftHandler,
  updateBusinessHandler,
} from './business.controller';

const businessRouter = Router();

businessRouter.use(asyncHandler(requireAuth));

businessRouter.get('/', asyncHandler(listBusinessesHandler));
businessRouter.post('/', asyncHandler(createBusinessHandler));
businessRouter.get('/onboarding-draft', asyncHandler(getDraftHandler));
businessRouter.put('/onboarding-draft', asyncHandler(putDraftHandler));
businessRouter.use(catalogRouter);
businessRouter.use(teamRouter);
businessRouter.use(scheduleRouter);
businessRouter.get('/:businessId', asyncHandler(getBusinessHandler));
businessRouter.patch('/:businessId', asyncHandler(updateBusinessHandler));
businessRouter.get('/:businessId/locations', asyncHandler(listLocationsHandler));
businessRouter.post('/:businessId/locations', asyncHandler(createLocationHandler));
businessRouter.get('/:businessId/onboarding', asyncHandler(getBusinessOnboardingHandler));

export { businessRouter };
