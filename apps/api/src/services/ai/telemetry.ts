/**
 * AI request telemetry.
 *
 * One row per model call, written whether it succeeded or failed. The row
 * deliberately contains no prompt and no completion: prompts carry borrower
 * names, balances and document text, and a telemetry table is exactly the kind
 * of place those end up read by someone who should not see them. What is stored
 * is enough to answer the questions an auditor actually asks — who used which
 * feature, against which records, with which model, for how long, at what token
 * cost, whether the output validated, and which data categories left the
 * process.
 */
import { AI_SCHEMA_VERSION, type AiFeature, type AiRequestStatus, type AiSourceRef } from '@eclens/shared';
import { env } from '../../config/env';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import type { AuditActor } from '../../lib/audit';
import type { GeminiUsage } from './geminiClient';

export interface AiTelemetryInput {
  organizationId: string;
  feature: AiFeature;
  status: AiRequestStatus;
  actor: AuditActor;
  model: string;
  latencyMs: number;
  attempts?: number;
  usage?: GeminiUsage;
  toolsUsed?: string[];
  toolCalls?: number;
  sourceRefs?: AiSourceRef[];
  dataCategoriesSent?: string[];
  redactionProfile?: string;
  groundingRejected?: boolean;
  errorCode?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
}

/**
 * Integer micro-USD, so cost telemetry never introduces a float into a table
 * that sits alongside financial records. Rounded, never summed with money.
 */
export function estimatedCostMicro(usage: GeminiUsage | undefined): number {
  if (!usage) return 0;
  const inputCost = (usage.promptTokens / 1000) * env.AI_COST_MICRO_PER_1K_INPUT;
  const outputCost = ((usage.completionTokens + usage.thoughtsTokens) / 1000) * env.AI_COST_MICRO_PER_1K_OUTPUT;
  return Math.max(0, Math.round(inputCost + outputCost));
}

/**
 * Best-effort by design. Losing a telemetry row is a gap in observability;
 * letting the insert throw would turn a successful analysis into a 500 for the
 * user, which is the worse failure.
 */
export async function recordAiRequest(input: AiTelemetryInput): Promise<string | null> {
  const id = newId();
  try {
    await prisma.aiRequest.create({
      data: {
        id,
        organizationId: input.organizationId,
        feature: input.feature,
        status: input.status,
        model: input.model,
        schemaVersion: AI_SCHEMA_VERSION,
        actorId: input.actor.id,
        actorName: input.actor.fullName,
        actorRole: input.actor.role,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        attempts: input.attempts ?? 1,
        promptTokens: input.usage?.promptTokens ?? 0,
        completionTokens: input.usage?.completionTokens ?? 0,
        totalTokens: input.usage?.totalTokens ?? 0,
        estimatedCostMicro: estimatedCostMicro(input.usage),
        toolCalls: input.toolCalls ?? 0,
        toolsUsed: [...new Set(input.toolsUsed ?? [])],
        sourceRefs: (input.sourceRefs ?? []) as unknown as object,
        dataCategoriesSent: [...new Set(input.dataCategoriesSent ?? [])],
        redactionProfile: input.redactionProfile ?? env.AI_REDACTION_PROFILE,
        groundingRejected: input.groundingRejected ?? false,
        errorCode: input.errorCode ?? null,
        conversationId: input.conversationId ?? null,
        requestId: input.requestId ?? null,
      },
    });
    return id;
  } catch (error) {
    logger.error(
      { feature: input.feature, status: input.status, reason: (error as Error)?.message },
      'Failed to persist AI request telemetry',
    );
    return null;
  }
}
