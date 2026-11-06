import { Router } from 'express';
import { createRateLimiter } from '../../middleware/rate-limit';
import { asyncHandler } from '../../utils/async-handler';
import {
  bookingPermissionsHandler,
  cancelBookingHandler,
  completeBookingHandler,
  createBookingHandler,
  getBookingHandler,
  guestCreateBookingHandler,
  guestSlotsHandler,
  listBookingsHandler,
  listSlotsHandler,
  noShowBookingHandler,
  rescheduleBookingHandler,
} from './booking.controller';

const bookingRouter = Router({ mergeParams: true });

bookingRouter.get('/:businessId/bookings/permissions', asyncHandler(bookingPermissionsHandler));
bookingRouter.get('/:businessId/booking-slots', asyncHandler(listSlotsHandler));
bookingRouter.get('/:businessId/bookings', asyncHandler(listBookingsHandler));
bookingRouter.post('/:businessId/bookings', asyncHandler(createBookingHandler));
bookingRouter.get('/:businessId/bookings/:bookingId', asyncHandler(getBookingHandler));
bookingRouter.post(
  '/:businessId/bookings/:bookingId/cancel',
  asyncHandler(cancelBookingHandler),
);
bookingRouter.post(
  '/:businessId/bookings/:bookingId/complete',
  asyncHandler(completeBookingHandler),
);
bookingRouter.post(
  '/:businessId/bookings/:bookingId/no-show',
  asyncHandler(noShowBookingHandler),
);
bookingRouter.post(
  '/:businessId/bookings/:bookingId/reschedule',
  asyncHandler(rescheduleBookingHandler),
);

export { bookingRouter };

const guestBookingRouter = Router();

const guestRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  keyPrefix: 'guest-booking',
});

guestBookingRouter.use(guestRateLimit);
guestBookingRouter.get('/slots', asyncHandler(guestSlotsHandler));
guestBookingRouter.post('/bookings', asyncHandler(guestCreateBookingHandler));

export { guestBookingRouter };
