/**
 * Analyst stage overrides: request, four-eyes review, and history.
 *
 * An override is the one place where a human judgement is allowed to beat the
 * model, so it is treated as a controlled record rather than a field update:
 *
 *   - The reason is mandatory and length-checked at the contract level.
 *   - Both the stage before and the stage after are stored, never just the new
 *     value, so the ledger can always show what was overruled.
 *   - The requester cannot review their own request. Reviewer and requester are
 *     stored separately with their own timestamps.
 *   - A PENDING_REVIEW override already takes effect (`toEngineOverride` only
 *     discards REJECTED ones), because holding a known-bad stage until someone
 *     clicks a button is worse than applying it and reviewing after. Rejecting
 *     re-runs the assessment, so the model stage comes back.
 *   - Every request and every review writes an immutable audit event and, for
 *     requests, an ANALYST_OVERRIDE exception so the queue surfaces it.
 *
 * The live stage itself is written only by `staging.service.ts`; this module
 * never touches `StagingAssessment` directly.
 */
import type { Prisma, RoleName } from '@prisma/client';
import {
  overrideException,
  type ListQuery,
  type OverrideReviewRequest,
  type Paginated,
  type Stage,
  type StageOverrideHistoryRecord,
  type StageOverrideListItem,
  type StageOverrideRequest,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { newId } from '../lib/ids';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { HttpError, forbidden, notFound } from '../utils/httpError';
import { toStageOverrideHistoryRecord } from './mappers';
import { findExposure } from './portfolio.service';
import { reassessExposure, activeRuleSet } from './staging.service';

/** Who may ask for an override. Reviewers and auditors may not. */
const OVERRIDE_REQUESTER_ROLES: RoleName[] = ['ADMIN', 'RISK_ANALYST'];
/** Who may decide on one. An analyst may not approve their own request. */
const OVERRIDE_REVIEWER_ROLES: RoleName[] = ['ADMIN', 'REVIEWER'];

const OVERRIDE_SORT_COLUMNS = ['occurredAt', 'stageBefore', 'stageAfter', 'reviewerStatus', 'actorName'] as const;

const overrideInclude = {
  exposure: {
    select: {
      id: true,
      publicId: true,
      segment: true,
      snapshotId: true,
      borrower: { select: { name: true } },
    },
  },
} as const;

/** The shape `overrideInclude` produces. Declared structurally, not via `GetPayload`. */
export interface OverrideRow {
  id: string;
  exposureId: string;
  stageBefore: number;
  stageAfter: number;
  reason: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  occurredAt: Date;
  reviewerStatus: string;
  reviewerName: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  exposure: {
    id: string;
    publicId: string;
    segment: string;
    snapshotId: string;
    borrower: { name: string };
  };
}

const toStage = (value: number): Stage => (value === 3 ? 3 : value === 2 ? 2 : 1);

export function toOverrideListItem(row: OverrideRow): StageOverrideListItem {
  return {
    ...toStageOverrideHistoryRecord(row),
    exposurePublicId: row.exposure.publicId,
    borrowerName: row.exposure.borrower.name,
    segment: row.exposure.segment,
  };
}

async function findOverride(organizationId: string, id: string): Promise<OverrideRow> {
  const row = await prisma.stageOverride.findFirst({ where: { id, organizationId }, include: overrideInclude });
  if (!row) throw notFound(`Stage override ${id} was not found`);
  return row;
}

/**
 * The stage the override is measured against: the exposure's live assessment if
 * one exists, otherwise a fresh assessment so a request is never rejected just
 * because nobody has staged the exposure yet.
 */
async function currentStageOf(organizationId: string, exposureId: string): Promise<Stage> {
  const live = await prisma.stagingAssessment.findFirst({
    where: { organizationId, exposureId, runId: null },
    orderBy: { assessedAt: 'desc' },
    select: { stage: true },
  });
  if (live) return toStage(live.stage);

  const exposure = await prisma.exposure.findFirst({
    where: { id: exposureId, organizationId },
    orderBy: { publicId: 'asc' },
  });
  if (!exposure) throw notFound(`Exposure ${exposureId} was not found`);

  const ruleSet = await activeRuleSet(organizationId);
  if (!ruleSet) {
    throw new HttpError(
      409,
      'NO_ACTIVE_MODEL_CONFIGURATION',
      'An active model configuration is required before a stage can be overridden, because the override is recorded against a governed rule set version.',
    );
  }
  const decision = await reassessExposure(exposure, ruleSet);
  if (!decision) throw new HttpError(409, 'STAGING_UNAVAILABLE', 'Staging could not be assessed for this exposure');
  return decision.stage;
}

/**
 * Records an override request. Returns the created record; the caller decides
 * what to render.
 */
export async function requestStageOverride(
  actor: AuditActor,
  exposureIdOrPublicId: string,
  input: StageOverrideRequest,
): Promise<StageOverrideHistoryRecord> {
  if (!OVERRIDE_REQUESTER_ROLES.includes(actor.role)) {
    throw forbidden(`Only ${OVERRIDE_REQUESTER_ROLES.join(' or ')} may request a stage override`);
  }

  const exposure = await findExposure(actor.organizationId, exposureIdOrPublicId);

  const pending = await prisma.stageOverride.findFirst({
    where: { exposureId: exposure.id, reviewerStatus: 'PENDING_REVIEW' },
    select: { id: true, actorName: true },
  });
  if (pending) {
    throw new HttpError(
      409,
      'OVERRIDE_ALREADY_PENDING',
      `An override requested by ${pending.actorName} is still awaiting review. It must be reviewed before another can be raised.`,
    );
  }

  const stageBefore = await currentStageOf(actor.organizationId, exposure.id);
  const stageAfter = toStage(input.stageAfter);
  if (stageBefore === stageAfter) {
    throw new HttpError(
      422,
      'OVERRIDE_NO_CHANGE',
      `The exposure is already Stage ${stageAfter}; an override must change the stage to be recorded.`,
    );
  }

  const created = await prisma.stageOverride.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      exposureId: exposure.id,
      stageBefore,
      stageAfter,
      reason: input.reason,
      actorId: actor.id,
      actorName: actor.fullName,
      actorRole: actor.role,
      reviewerStatus: 'PENDING_REVIEW',
    },
    include: overrideInclude,
  });

  const ruleSet = await activeRuleSet(actor.organizationId);
  if (ruleSet) {
    const row = await prisma.exposure.findUniqueOrThrow({ where: { id: exposure.id } });
    await reassessExposure(row, ruleSet);
  }

  const candidate = overrideException(exposure.publicId, {
    stageBefore,
    stageAfter,
    reason: input.reason,
    actorName: actor.fullName,
  });
  await prisma.exceptionItem.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      kind: candidate.kind,
      severity: candidate.severity,
      status: 'OPEN',
      exposureId: exposure.id,
      title: candidate.title,
      detail: candidate.detail,
      metric: candidate.metric ?? null,
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'EXPOSURE.STAGE_OVERRIDE_REQUESTED',
    entityType: 'Exposure',
    entityId: exposure.publicId,
    detail: `Requested Stage ${stageBefore} → ${stageAfter} for ${exposure.publicId} (${exposure.borrower.name}). Reason: ${input.reason}. Awaiting review.`,
  });

  return toStageOverrideHistoryRecord(created);
}

/**
 * Four-eyes decision on a pending override. Rejecting restores the model stage
 * because `toEngineOverride` ignores REJECTED rows and the live assessment is
 * re-run immediately afterwards.
 */
export async function reviewStageOverride(
  actor: AuditActor,
  overrideId: string,
  input: OverrideReviewRequest,
): Promise<StageOverrideHistoryRecord> {
  if (!OVERRIDE_REVIEWER_ROLES.includes(actor.role)) {
    throw forbidden(`Only ${OVERRIDE_REVIEWER_ROLES.join(' or ')} may review a stage override`);
  }

  const row = await findOverride(actor.organizationId, overrideId);
  if (row.reviewerStatus !== 'PENDING_REVIEW') {
    throw new HttpError(
      409,
      'OVERRIDE_ALREADY_REVIEWED',
      `This override was already ${row.reviewerStatus.toLowerCase()} by ${row.reviewerName ?? 'another reviewer'}.`,
    );
  }
  if (row.actorId === actor.id) {
    throw new HttpError(
      409,
      'OVERRIDE_SELF_REVIEW_PROHIBITED',
      'You requested this override and cannot review it. A different reviewer must decide.',
    );
  }

  const updated = await prisma.stageOverride.update({
    where: { id: row.id },
    data: {
      reviewerStatus: input.decision,
      reviewerId: actor.id,
      reviewerName: actor.fullName,
      reviewedAt: new Date(),
      reviewComment: input.comment,
    },
    include: overrideInclude,
  });

  const ruleSet = await activeRuleSet(actor.organizationId);
  if (ruleSet) {
    const exposure = await prisma.exposure.findUniqueOrThrow({ where: { id: row.exposureId } });
    await reassessExposure(exposure, ruleSet);
  }

  await prisma.exceptionItem.updateMany({
    where: {
      organizationId: actor.organizationId,
      exposureId: row.exposureId,
      kind: 'ANALYST_OVERRIDE',
      status: { not: 'RESOLVED' },
    },
    data: {
      status: input.decision === 'REVIEWED' ? 'ACKNOWLEDGED' : 'RESOLVED',
      acknowledgedById: actor.id,
      acknowledgedBy: actor.fullName,
      acknowledgedAt: new Date(),
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'EXPOSURE.STAGE_OVERRIDE_REVIEWED',
    entityType: 'Exposure',
    entityId: row.exposure.publicId,
    detail: `${input.decision === 'REVIEWED' ? 'Approved' : 'Rejected'} override ${row.id} on ${row.exposure.publicId} (Stage ${row.stageBefore} → ${row.stageAfter}, requested by ${row.actorName}). Comment: ${input.comment}.`,
  });

  return toStageOverrideHistoryRecord(updated);
}

/** The review queue and history view. Filters: `status` maps to reviewerStatus. */
export async function listStageOverrides(
  organizationId: string,
  query: ListQuery & { status?: 'PENDING_REVIEW' | 'REVIEWED' | 'REJECTED' },
): Promise<Paginated<StageOverrideListItem>> {
  const term = query.search?.trim();
  const where: Prisma.StageOverrideWhereInput = {
    organizationId,
    ...(query.status ? { reviewerStatus: query.status } : {}),
    ...(query.segment ? { exposure: { segment: query.segment } } : {}),
    ...(term
      ? {
          OR: [
            ...(containsSearch(term, ['reason', 'actorName', 'reviewerName']) ?? []),
            { exposure: { publicId: { contains: term } } },
            { exposure: { borrower: { name: { contains: term } } } },
          ],
        }
      : {}),
  };

  const [totalItems, rows] = await Promise.all([
    prisma.stageOverride.count({ where }),
    prisma.stageOverride.findMany({
      where,
      include: overrideInclude,
      ...toPageArgs(query),
      orderBy: orderBy(query.sortBy, query.sortDir, OVERRIDE_SORT_COLUMNS, { occurredAt: 'desc' }),
    }),
  ]);

  return {
    items: rows.map(toOverrideListItem),
    meta: buildPageMeta(query, totalItems),
  };
}

/** Full override history for one exposure, newest first. */
export async function overrideHistory(
  organizationId: string,
  exposureIdOrPublicId: string,
): Promise<StageOverrideHistoryRecord[]> {
  // Resolved rather than matched directly: callers hold the publicId, because
  // that is what every exposure endpoint returns. Matching the raw parameter
  // against `exposureId` would silently report "no overrides" for a publicId.
  const exposure = await findExposure(organizationId, exposureIdOrPublicId);
  const rows = await prisma.stageOverride.findMany({
    where: { organizationId, exposureId: exposure.id },
    orderBy: { occurredAt: 'desc' },
  });
  return rows.map(toStageOverrideHistoryRecord);
}
