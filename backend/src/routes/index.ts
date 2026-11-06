import { Router } from 'express';
import { API_VERSION_PREFIX } from '@fadezy/shared';
import { requireAuth } from '../middleware/require-auth';
import { asyncHandler } from '../utils/async-handler';
import { authRouter } from '../modules/auth/auth.routes';
import { guestBookingRouter } from '../modules/booking/booking.routes';
import { businessRouter } from '../modules/businesses/business.routes';
import { healthRouter } from '../modules/health/health.routes';
import { invitationAcceptRouter } from '../modules/team/team.routes';

export function registerRoutes(): Router {
  const router = Router();

  router.use(`${API_VERSION_PREFIX}/health`, healthRouter);
  router.use(`${API_VERSION_PREFIX}/auth`, authRouter);
  router.use(`${API_VERSION_PREFIX}/public/booking`, guestBookingRouter);
  router.use(
    `${API_VERSION_PREFIX}/invitations`,
    asyncHandler(requireAuth),
    invitationAcceptRouter,
  );
  router.use(`${API_VERSION_PREFIX}/businesses`, businessRouter);

  return router;
}
