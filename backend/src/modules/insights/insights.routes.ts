import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { getWorkspaceOverviewHandler } from './insights.controller';

export const insightsRouter = Router({ mergeParams: true });

insightsRouter.get(
  '/:businessId/insights/overview',
  asyncHandler(getWorkspaceOverviewHandler),
);
