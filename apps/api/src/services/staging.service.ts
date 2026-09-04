/**
 * Live staging assessment.
 *
 * One place decides what an exposure's *current* stage is, and one place writes
 * it. The convention: a `StagingAssessment` with `runId: null` is the single
 * live assessment for an exposure — it is replaced, never appended to — while
 * run-scoped assessments (`runId` set) are the immutable per-run record written
 * by `runs.service.ts`. History therefore lives in `StageOverride` rows and in
 * `EXPOSURE.STAGED` audit events, not in a pile of live assessments.
 *
 * The rule set is always read from the active model configuration, so the
 * thresholds applied are the governed, versioned ones — nothing here hard-codes
 * a regulatory judgment.
 */
import type { Prisma } from '@prisma/client';
import {
  assessStage,
  type StagingDecision,
  type StagingInput,
  type StagingRuleSetConfig,
} from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { newId } from '../lib/ids';
import { prisma } from '../lib/prisma';
import { jsonAs } from './mappers';
import { toEngineOverride, type OverrideEngineRow } from './engine-bridge';

/** Only the columns `assessStage` actually reads, so any exposure row fits. */
export interface StagingSourceRow {
  id: string;
  publicId: string;
  snapshotId: string;
  organizationId: string;
  daysPastDue: number;
  defaultFlag: boolean;
  creditImpairedFlag: boolean;
  forbearanceFlag: boolean;
  restructuringFlag: boolean;
  watchlistFlag: boolean;
  originalCreditRating: string;
  currentCreditRating: string;
  pdAtOrigination: Prisma.Decimal;
  twelveMonthPd: Prisma.Decimal;
}

export function stagingInputOf(row: StagingSourceRow): StagingInput {
  return {
    daysPastDue: row.daysPastDue,
    defaultFlag: row.defaultFlag,
    creditImpairedFlag: row.creditImpairedFlag,
    forbearanceFlag: row.forbearanceFlag,
    restructuringFlag: row.restructuringFlag,
    watchlistFlag: row.watchlistFlag,
    originalCreditRating: row.originalCreditRating,
    currentCreditRating: row.currentCreditRating,
    pdAtOrigination: row.pdAtOrigination.toString(),
    currentPd: row.twelveMonthPd.toString(),
  };
}

/** The governed rule set in force for this organization, or null if none. */
export async function activeRuleSet(organizationId: string): Promise<StagingRuleSetConfig | null> {
  const configuration = await prisma.modelConfiguration.findFirst({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: { stagingRuleSet: true },
  });
  return configuration ? jsonAs<StagingRuleSetConfig | null>(configuration.stagingRuleSet, null) : null;
}

/**
 * The override currently in force for an exposure, as the raw row. A REJECTED
 * override is history rather than an instruction, so it is filtered out here and
 * the exposure falls back to its modelled stage; callers hand the result to
 * `toEngineOverride`, which applies the same rule and normalises the fields.
 */
export async function activeOverride(exposureId: string): Promise<OverrideEngineRow | null> {
  const row = await prisma.stageOverride.findFirst({
    where: { exposureId, reviewerStatus: { not: 'REJECTED' } },
    orderBy: { occurredAt: 'desc' },
  });
  return row ? (row as unknown as OverrideEngineRow) : null;
}

/** Replaces the live assessment and records the decision in the audit trail. */
export async function persistLiveAssessment(
  organizationId: string,
  exposureId: string,
  decision: StagingDecision,
  overrideId: string | null,
): Promise<void> {
  await prisma.stagingAssessment.deleteMany({ where: { organizationId, exposureId, runId: null } });
  await prisma.stagingAssessment.create({
    data: {
      id: newId(),
      organizationId,
      runId: null,
      exposureId,
      stage: decision.stage,
      modelStage: decision.modelStage,
      primaryReason: decision.primaryReason,
      primaryRuleCode: decision.primaryRuleCode,
      triggeredRules: decision.triggeredRules as unknown as Prisma.InputJsonValue,
      ruleSetId: decision.ruleSetId,
      ruleSetVersion: decision.ruleSetVersion,
      hasOverride: decision.hasOverride,
      overrideId,
    },
  });
}

/**
 * Recomputes and persists one exposure's live stage. Returns null when there is
 * no active model configuration, because inventing a rule set would be exactly
 * the silent regulatory judgment this platform must not make.
 */
export async function reassessExposure(
  exposure: StagingSourceRow,
  ruleSet: StagingRuleSetConfig | null,
): Promise<StagingDecision | null> {
  if (!ruleSet) return null;
  const overrideRow = await activeOverride(exposure.id);
  const decision = assessStage(stagingInputOf(exposure), ruleSet, toEngineOverride(overrideRow));
  await persistLiveAssessment(exposure.organizationId, exposure.id, decision, overrideRow?.id ?? null);
  return decision;
}

/**
 * Recomputes the live stage for every exposure in a snapshot. Called after an
 * override is requested or reviewed so the portfolio list reflects it without
 * waiting for the next full run.
 */
export async function reassessSnapshot(
  organizationId: string,
  snapshotId: string,
  actor: AuditActor | null,
): Promise<{ assessed: number; decision: StagingDecision | null }> {
  const ruleSet = await activeRuleSet(organizationId);
  if (!ruleSet) return { assessed: 0, decision: null };

  const [exposures, overrides] = await Promise.all([
    prisma.exposure.findMany({
      where: { organizationId, snapshotId },
      orderBy: { publicId: 'asc' },
    }),
    prisma.stageOverride.findMany({
      where: { organizationId, reviewerStatus: { not: 'REJECTED' } },
      orderBy: { occurredAt: 'desc' },
    }),
  ]);

  const latestOverride = new Map<string, (typeof overrides)[number]>();
  for (const override of overrides) {
    if (!latestOverride.has(override.exposureId)) latestOverride.set(override.exposureId, override);
  }

  let lastDecision: StagingDecision | null = null;
  for (const row of exposures as unknown as StagingSourceRow[]) {
    const overrideRow = latestOverride.get(row.id) ?? null;
    const decision = assessStage(
      stagingInputOf(row),
      ruleSet,
      toEngineOverride(overrideRow as unknown as OverrideEngineRow | null),
    );
    await persistLiveAssessment(organizationId, row.id, decision, overrideRow?.id ?? null);
    lastDecision = decision;
  }

  if (actor && exposures.length > 0) {
    await recordAudit({
      organizationId,
      actor,
      action: 'EXPOSURE.STAGED',
      entityType: 'PortfolioSnapshot',
      entityId: snapshotId,
      detail: `Re-assessed ${exposures.length} exposure(s) against staging rule set ${ruleSet.id} v${ruleSet.version}.`,
    });
  }

  return { assessed: exposures.length, decision: lastDecision };
}
