/**
 * Append-only audit trail.
 *
 * Every row written here is immutable: this module exposes a create function
 * and nothing else. There is deliberately no update, no delete and no upsert,
 * so no code path in the API can rewrite history. The Prisma model reinforces
 * this by having no `updatedAt` column.
 */
import type { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { unauthorized } from '../utils/httpError';
import { prisma } from './prisma';

export interface AuditActor {
  id: string;
  organizationId: string;
  fullName: string;
  role: RoleName;
}

export interface AuditEventInput {
  organizationId: string;
  /** Null for pre-authentication events such as a failed login. */
  actor: Pick<AuditActor, 'id' | 'fullName' | 'role'> | null;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  ipAddress?: string | null;
  requestId?: string | null;
}

export async function recordAudit(input: AuditEventInput): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      userId: input.actor?.id ?? null,
      userName: input.actor?.fullName ?? 'anonymous',
      role: input.actor?.role ?? 'AUDITOR',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      detail: input.detail,
      ipAddress: input.ipAddress ?? null,
      requestId: input.requestId ?? null,
    },
  });
}

/**
 * Builds the actor/request context from an authenticated Express request.
 * Kept separate from `recordAudit` so services stay testable without a request.
 */
export function auditContext(req: Request): {
  actor: Pick<AuditActor, 'id' | 'fullName' | 'role'> | null;
  organizationId: string;
  ipAddress: string | null;
  requestId: string | null;
} {
  const user = req.user;
  return {
    actor: user ? { id: user.id, fullName: user.fullName, role: user.role } : null,
    organizationId: user?.organizationId ?? '',
    ipAddress: req.ip ?? null,
    requestId: req.requestId ?? null,
  };
}

/** Records an audit event from a request, swallowing nothing: failures propagate. */
export async function recordAuditFromRequest(
  req: Request,
  event: Omit<AuditEventInput, 'organizationId' | 'actor' | 'ipAddress' | 'requestId'>,
): Promise<void> {
  const context = auditContext(req);
  await recordAudit({ ...event, ...context });
}

/**
 * The complete actor a service needs. Routes using this always sit behind
 * `requireAuth`, so a missing user is an authentication failure rather than a
 * programming error.
 */
export function currentActor(req: Request): AuditActor {
  const user = req.user;
  if (!user) throw unauthorized();
  return {
    id: user.id,
    organizationId: user.organizationId,
    fullName: user.fullName,
    role: user.role,
  };
}
