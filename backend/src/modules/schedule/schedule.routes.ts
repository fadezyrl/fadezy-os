import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  approveTimeOffHandler,
  availabilityContextHandler,
  cancelExceptionHandler,
  cancelTimeOffHandler,
  createExceptionHandler,
  createTimeOffHandler,
  getBusinessHoursHandler,
  getLocationHoursHandler,
  listExceptionsHandler,
  listStaffSchedulesHandler,
  listTimeOffHandler,
  permissionsHandler,
  putBusinessHoursHandler,
  putLocationHoursHandler,
  putStaffScheduleHandler,
  rejectTimeOffHandler,
} from './schedule.controller';

const scheduleRouter = Router({ mergeParams: true });

scheduleRouter.get('/:businessId/schedule/permissions', asyncHandler(permissionsHandler));
scheduleRouter.get('/:businessId/operating-hours', asyncHandler(getBusinessHoursHandler));
scheduleRouter.put('/:businessId/operating-hours', asyncHandler(putBusinessHoursHandler));

scheduleRouter.get(
  '/:businessId/locations/:locationId/operating-hours',
  asyncHandler(getLocationHoursHandler),
);
scheduleRouter.put(
  '/:businessId/locations/:locationId/operating-hours',
  asyncHandler(putLocationHoursHandler),
);

scheduleRouter.get('/:businessId/schedule-exceptions', asyncHandler(listExceptionsHandler));
scheduleRouter.post('/:businessId/schedule-exceptions', asyncHandler(createExceptionHandler));
scheduleRouter.post(
  '/:businessId/schedule-exceptions/:exceptionId/cancel',
  asyncHandler(cancelExceptionHandler),
);

scheduleRouter.get(
  '/:businessId/members/:memberId/schedules',
  asyncHandler(listStaffSchedulesHandler),
);
scheduleRouter.put(
  '/:businessId/members/:memberId/schedules',
  asyncHandler(putStaffScheduleHandler),
);

scheduleRouter.get('/:businessId/time-off', asyncHandler(listTimeOffHandler));
scheduleRouter.post('/:businessId/time-off', asyncHandler(createTimeOffHandler));
scheduleRouter.post(
  '/:businessId/time-off/:timeOffId/approve',
  asyncHandler(approveTimeOffHandler),
);
scheduleRouter.post('/:businessId/time-off/:timeOffId/reject', asyncHandler(rejectTimeOffHandler));
scheduleRouter.post('/:businessId/time-off/:timeOffId/cancel', asyncHandler(cancelTimeOffHandler));

scheduleRouter.get('/:businessId/availability/context', asyncHandler(availabilityContextHandler));

export { scheduleRouter };
