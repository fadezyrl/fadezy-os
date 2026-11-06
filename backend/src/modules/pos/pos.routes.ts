import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  adjustRegisterHandler,
  checkoutBookingHandler,
  closeRegisterHandler,
  createWalkInSaleHandler,
  dailySummaryHandler,
  getOpenRegisterHandler,
  getRegisterSessionHandler,
  getSaleByBookingHandler,
  getSaleHandler,
  getTaxSettingsHandler,
  listSalesHandler,
  openRegisterHandler,
  posPermissionsHandler,
  recordPaymentHandler,
  refundPaymentHandler,
  updateOpenSaleHandler,
  updateTaxSettingsHandler,
  voidSaleHandler,
} from './pos.controller';

const posRouter = Router({ mergeParams: true });

posRouter.get('/:businessId/pos/permissions', asyncHandler(posPermissionsHandler));
posRouter.get('/:businessId/pos/tax-settings', asyncHandler(getTaxSettingsHandler));
posRouter.patch('/:businessId/pos/tax-settings', asyncHandler(updateTaxSettingsHandler));

posRouter.post('/:businessId/pos/sales', asyncHandler(createWalkInSaleHandler));
posRouter.post('/:businessId/pos/sales/checkout-booking', asyncHandler(checkoutBookingHandler));
posRouter.get('/:businessId/pos/sales', asyncHandler(listSalesHandler));
posRouter.get('/:businessId/pos/sales/by-booking/:bookingId', asyncHandler(getSaleByBookingHandler));
posRouter.get('/:businessId/pos/sales/:saleId', asyncHandler(getSaleHandler));
posRouter.patch('/:businessId/pos/sales/:saleId', asyncHandler(updateOpenSaleHandler));
posRouter.post('/:businessId/pos/sales/:saleId/payments', asyncHandler(recordPaymentHandler));
posRouter.post(
  '/:businessId/pos/sales/:saleId/payments/:paymentId/refunds',
  asyncHandler(refundPaymentHandler),
);
posRouter.post('/:businessId/pos/sales/:saleId/void', asyncHandler(voidSaleHandler));

posRouter.get('/:businessId/pos/summaries/daily', asyncHandler(dailySummaryHandler));

posRouter.get('/:businessId/pos/register-sessions/open', asyncHandler(getOpenRegisterHandler));
posRouter.post('/:businessId/pos/register-sessions', asyncHandler(openRegisterHandler));
posRouter.get(
  '/:businessId/pos/register-sessions/:sessionId',
  asyncHandler(getRegisterSessionHandler),
);
posRouter.post(
  '/:businessId/pos/register-sessions/:sessionId/close',
  asyncHandler(closeRegisterHandler),
);
posRouter.post(
  '/:businessId/pos/register-sessions/:sessionId/adjustments',
  asyncHandler(adjustRegisterHandler),
);

export { posRouter };
