import { Router } from 'express';
import { createRateLimiter } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { asyncHandler } from '../../utils/async-handler';
import { authMeHandler, authVerifyHandler } from './auth.controller';

const authRouter = Router();

const authRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  keyPrefix: 'auth',
});

authRouter.use(authRateLimit);

authRouter.get('/me', asyncHandler(requireAuth), authMeHandler);
authRouter.post('/verify', asyncHandler(requireAuth), authVerifyHandler);

export { authRouter };
