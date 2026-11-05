import type { AuthenticatedUser, UserProfile } from '@fadezy/shared';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        accessToken: string;
        user: AuthenticatedUser;
        profile: UserProfile | null;
      };
    }
  }
}

export {};
