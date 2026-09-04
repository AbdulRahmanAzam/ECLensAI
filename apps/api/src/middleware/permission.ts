/**
 * Feature-level authorization.
 *
 * `requireRole` answers "who are you". This answers "may you do this". The
 * matrix itself lives in `@eclens/shared` (`ROLE_PERMISSIONS`) so the web client
 * can hide an action the API would refuse, instead of the two disagreeing at
 * runtime — one source of truth for who may override a stage or approve a run.
 */
import type { NextFunction, Request, Response } from 'express';
import { permissionsForRole, type RoleName } from '@eclens/shared';
import { unauthorized } from '../utils/httpError';

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!permissionsForRole(req.user.role as RoleName).includes(permission)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Requires permission: ${permission}`,
          requestId: req.requestId,
        },
      });
      return;
    }
    next();
  };
}
