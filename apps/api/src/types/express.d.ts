import type { RoleName } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: RoleName;
  /**
   * The role's permissions, resolved server-side so the client and the
   * `requirePermission` middleware can never disagree about what a role holds.
   */
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      user?: AuthenticatedUser;
    }
  }
}

export {};
