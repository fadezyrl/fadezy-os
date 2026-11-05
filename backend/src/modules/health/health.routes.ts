import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { healthHandler, readinessHandler } from './health.controller';

const healthRouter = Router();

healthRouter.get('/', healthHandler);
healthRouter.get('/ready', asyncHandler(readinessHandler));

export { healthRouter };
