import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import {
  archiveAddonHandler,
  archiveCategoryHandler,
  archiveServiceHandler,
  createAddonHandler,
  createCategoryHandler,
  createServiceHandler,
  getCategoryHandler,
  getServiceHandler,
  listAddonsHandler,
  listCategoriesHandler,
  listServicesHandler,
  reorderCategoriesHandler,
  reorderServicesHandler,
  setServiceAddonsHandler,
  updateAddonHandler,
  updateCategoryHandler,
  updateServiceHandler,
  upsertLocationSettingsHandler,
} from './catalog.controller';

/** Mounted on the businesses router (auth already applied). */
const catalogRouter = Router({ mergeParams: true });

catalogRouter.get('/:businessId/service-categories', asyncHandler(listCategoriesHandler));
catalogRouter.post('/:businessId/service-categories', asyncHandler(createCategoryHandler));
catalogRouter.post(
  '/:businessId/service-categories/reorder',
  asyncHandler(reorderCategoriesHandler),
);
catalogRouter.get('/:businessId/service-categories/:categoryId', asyncHandler(getCategoryHandler));
catalogRouter.patch(
  '/:businessId/service-categories/:categoryId',
  asyncHandler(updateCategoryHandler),
);
catalogRouter.delete(
  '/:businessId/service-categories/:categoryId',
  asyncHandler(archiveCategoryHandler),
);

catalogRouter.get('/:businessId/services', asyncHandler(listServicesHandler));
catalogRouter.post('/:businessId/services', asyncHandler(createServiceHandler));
catalogRouter.post('/:businessId/services/reorder', asyncHandler(reorderServicesHandler));
catalogRouter.get('/:businessId/services/:serviceId', asyncHandler(getServiceHandler));
catalogRouter.patch('/:businessId/services/:serviceId', asyncHandler(updateServiceHandler));
catalogRouter.delete('/:businessId/services/:serviceId', asyncHandler(archiveServiceHandler));
catalogRouter.put(
  '/:businessId/services/:serviceId/locations',
  asyncHandler(upsertLocationSettingsHandler),
);
catalogRouter.put(
  '/:businessId/services/:serviceId/addons',
  asyncHandler(setServiceAddonsHandler),
);

catalogRouter.get('/:businessId/service-addons', asyncHandler(listAddonsHandler));
catalogRouter.post('/:businessId/service-addons', asyncHandler(createAddonHandler));
catalogRouter.patch('/:businessId/service-addons/:addonId', asyncHandler(updateAddonHandler));
catalogRouter.delete('/:businessId/service-addons/:addonId', asyncHandler(archiveAddonHandler));

export { catalogRouter };
