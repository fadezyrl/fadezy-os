import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  listNotificationPreferencesHandler,
  listNotificationsHandler,
  markNotificationReadHandler,
  updateNotificationPreferencesHandler,
} from './notifications.controller';

const notificationsRouter = Router({ mergeParams: true });

notificationsRouter.get(
  '/:businessId/notifications',
  asyncHandler(listNotificationsHandler),
);
notificationsRouter.post(
  '/:businessId/notifications/:notificationId/read',
  asyncHandler(markNotificationReadHandler),
);
notificationsRouter.get(
  '/:businessId/notification-preferences',
  asyncHandler(listNotificationPreferencesHandler),
);
notificationsRouter.patch(
  '/:businessId/notification-preferences',
  asyncHandler(updateNotificationPreferencesHandler),
);

export { notificationsRouter };
