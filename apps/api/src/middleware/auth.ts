import type { RoleName } from '@prisma/client';
import { permissionsForRole, type RoleName as SharedRoleName } from '@eclens/shared';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../utils/httpError';
import { COOKIE_NAME } from '../services/auth.service';

interface JwtPayload {
  sub: string;
}

/** Verifies the JWT in the httpOnly cookie and loads the active user. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (!token) {
      next(unauthorized('Missing session cookie'));
      return;
    }

    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || !user.isActive) {
      next(unauthorized('Session is no longer valid'));
      return;
    }

    req.user = {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role.name,
      permissions: [...permissionsForRole(user.role.name as SharedRoleName)],
    };
    next();
  } catch {
    next(unauthorized('Session is invalid or expired'));
  }
}

/**
 * Coarse role gate. Most routes use `requirePermission` instead, which checks the
 * per-role feature matrix; this one is for the few places where a whole role is
 * the right unit.
 */
export function requireRole(...roles: RoleName[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(forbidden().status).json({
        error: {
          code: forbidden().code,
          message: `Requires role: ${roles.join(' or ')}`,
          requestId: req.requestId,
        },
      });
      return;
    }
    next();
  };
}
