import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  archiveCustomerHandler,
  createCustomerHandler,
  getCustomerHandler,
  listCustomerBookingsHandler,
  listCustomersHandler,
  restoreCustomerHandler,
  updateCustomerHandler,
} from './customers.controller';

/** Mounted on the businesses router (auth already applied). */
const customersRouter = Router({ mergeParams: true });

customersRouter.get('/:businessId/customers', asyncHandler(listCustomersHandler));
customersRouter.post('/:businessId/customers', asyncHandler(createCustomerHandler));
customersRouter.get('/:businessId/customers/:customerId', asyncHandler(getCustomerHandler));
customersRouter.patch('/:businessId/customers/:customerId', asyncHandler(updateCustomerHandler));
customersRouter.post(
  '/:businessId/customers/:customerId/archive',
  asyncHandler(archiveCustomerHandler),
);
customersRouter.post(
  '/:businessId/customers/:customerId/restore',
  asyncHandler(restoreCustomerHandler),
);
customersRouter.get(
  '/:businessId/customers/:customerId/bookings',
  asyncHandler(listCustomerBookingsHandler),
);

export { customersRouter };
