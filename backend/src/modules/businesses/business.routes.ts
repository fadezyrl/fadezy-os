import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth';
import { asyncHandler } from '../../utils/async-handler';
import { bookingRouter } from '../booking/booking.routes';
import { catalogRouter } from '../catalog/catalog.routes';
import { customersRouter } from '../customers/customers.routes';
import { insightsRouter } from '../insights/insights.routes';
import { notificationsRouter } from '../notifications/notifications.routes';
import { posRouter } from '../pos/pos.routes';
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
businessRouter.use(customersRouter);
businessRouter.use(posRouter);
businessRouter.use(notificationsRouter);
businessRouter.use(insightsRouter);
businessRouter.use(bookingRouter);
businessRouter.get('/:businessId', asyncHandler(getBusinessHandler));
businessRouter.patch('/:businessId', asyncHandler(updateBusinessHandler));
businessRouter.get('/:businessId/locations', asyncHandler(listLocationsHandler));
businessRouter.post('/:businessId/locations', asyncHandler(createLocationHandler));
businessRouter.get('/:businessId/onboarding', asyncHandler(getBusinessOnboardingHandler));

export { businessRouter };
