import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { permissionsForRole, type RoleName as SharedRoleName } from '@eclens/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';
import type { AuthenticatedUser } from '../types/express';

export const COOKIE_NAME = 'eclens_token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // matches JWT_EXPIRES_IN=12h default

export interface LoginResult {
  token: string;
  user: AuthenticatedUser & { organizationName: string };
}

export async function login(email: string, password: string, ipAddress: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { role: true, organization: true },
  });
  if (!user || !user.isActive) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const token = jwt.sign(
    { sub: user.id, orgId: user.organizationId, role: user.role.name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] },
  );

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditEvent.create({
    data: {
      organizationId: user.organizationId,
      userId: user.id,
      userName: user.fullName,
      role: user.role.name,
      action: 'AUTH.LOGIN',
      entityType: 'Session',
      entityId: user.id,
      detail: 'Successful sign-in',
      ipAddress,
    },
  });

  return {
    token,
    user: {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role.name,
      permissions: [...permissionsForRole(user.role.name as SharedRoleName)],
      organizationName: user.organization.name,
    },
  };
}

export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}
