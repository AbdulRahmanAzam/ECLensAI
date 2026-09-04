/**
 * The AI request pipeline.
 *
 * Every one of the seven features runs through `runAiFeature`, so the guarantees
 * the product makes about AI are implemented once rather than seven times:
 *
 *   1. **Availability first.** No key, no SDK or `AI_ENABLED=false` throws
 *      `AI_UNAVAILABLE` before any prompt is assembled. Nothing downstream can
 *      fabricate a live answer to cover the gap.
 *   2. **Tools gather, the schema disposes.** The tool phase may only call the
 *      eight registered read-only functions. The synthesis phase is sent with
 *      `toolChoice: 'NONE'` and a JSON Schema, so the model cannot reach for a
 *      tool at the moment it is writing figures.
 *   3. **Validated twice.** The provider constrains the shape; Zod then
 *      re-validates the parsed JSON, because a constrained decoder is not a
 *      guarantee. One repair round with the concrete problems named, then a
 *      structured error.
 *   4. **Grounded.** After validation, every material number in a *descriptive*
 *      response must appear in the evidence that was actually retrieved.
 *   5. **Recorded.** One telemetry row per call, success or failure, with no
 *      prompt text and no completion text in it.
 *
 * Streaming is deliberately not used. A streamed answer reaches the user token
 * by token, which means an ungrounded figure would already be on screen before
 * the guard could reject it. Correctness of the numbers outranks perceived
 * latency here, so the response is validated as a whole and then sent.
 */
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { AiFeature, AiRequestStatus, AiSourceRef, AiToolActivity } from '@eclens/shared';
import { assertAiAvailable } from './availability';
import { aiEvidenceMissing, aiGroundingRejected, aiInputTooLarge, aiSchemaInvalid, AiError } from './aiErrors';
import { findUngroundedClaimsInValue, responseSchemaFor } from './grounding';
import { GROUNDING_REMINDER, buildRepairInstruction, buildSystemInstruction } from './prompts';
import { createRedactor, toLogSafe, type DataCategory, type Redactor } from './redaction';
import { recordAiRequest } from './telemetry';
import {
  geminiClient,
  type AiContent,
  type GeminiClient,
  type GeminiUsage,
} from './geminiClient';
import { executeTool, toolDeclarations, type ToolContext } from './tools';
import { knowledgeRetriever, type KnowledgeRetriever } from './retrieval';
import type { AuditActor } from '../../lib/audit';

/**
 * Features whose numbers *describe stored records*, so every material figure
 * must have arrived inside the evidence.
 *
 * The two proposal features are absent on purpose. `SCENARIO_DRAFT` is asked to
 * invent weights and multipliers and `IMPORT_MAPPING` to state a confidence —
 * numbers that by definition are not in the evidence yet. Requiring them to be
 * grounded would make both features impossible. They are safe for a different
 * reason: their output carries `requiresApproval: true`, is bounded by schema,
 * and cannot take effect until a person confirms it through a normal audited
 * endpoint. The guard is about not misstating the books, not about forbidding
 * a clearly-labelled suggestion.
 */
const STRICT_GROUNDING: ReadonlySet<AiFeature> = new Set<AiFeature>([
  'PORTFOLIO_COPILOT',
  'EXPLAIN_ECL',
  'DATA_QUALITY_INVESTIGATION',
  'DOCUMENT_INTELLIGENCE',
  'EXECUTIVE_COMMENTARY',
]);

/** What a tool call looks like in the UI while it is in flight or has failed. */
const TOOL_LABELS: Record<string, string> = {
  getPortfolioSummary: 'Reading the portfolio summary',
  getExposureDetails: 'Opening the exposure record',
  getCalculationTrace: 'Reading the calculation trace',
  compareRuns: 'Comparing the two runs',
  getScenarioComparison: 'Reading the scenario contributions',
  getStageMigration: 'Reading the stage migration',
  getDataQualityIssues: 'Checking data quality',
  searchGovernanceKnowledge: 'Searching governance knowledge',
};

export interface AiRunOptions<T> {
  feature: AiFeature;
  actor: AuditActor;
  /**
   * Contract the parsed model output must satisfy.
   *
   * Typed with an `unknown` *input* on purpose: every feature schema defaults
   * its array and label fields, so the model may omit them and Zod fills them
   * in. Input and output types are therefore not the same type, and declaring
   * them equal would reject every real schema.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** The request in the user's own words. Placed in a delimited user turn. */
  prompt: string;
  /**
   * Evidence the caller fetched deterministically before calling the model —
   * a batch's headers, a trace, a document's text. Same fenced format as tool
   * output, so the model treats both identically.
   */
  evidence?: string[];
  /** Source refs the caller knows about whatever the model cites. */
  knownSourceRefs?: AiSourceRef[];
  /** Data categories the caller's own evidence puts on the wire. */
  dataCategories?: DataCategory[];
  /** Let the model call the read-only tools to gather more evidence. */
  allowTools?: boolean;
  temperature?: number;
  conversationId?: string | null;
  requestId?: string | null;
  client?: GeminiClient;
  retriever?: KnowledgeRetriever;
  /**
   * Supply this when the caller builds its own evidence, so that evidence is
   * pseudonymized by the same redactor the tools use. A caller that redacts with
   * a different instance would send real borrower names to the model and lose
   * the ability to restore the aliases in the answer.
   */
  redactor?: Redactor;
}

export interface AiRunResult<T> {
  result: T;
  status: AiRequestStatus;
  model: string;
  latencyMs: number;
  /** Everything the model was allowed to see; also the grounding corpus. */
  evidence: string[];
  sourceRefs: AiSourceRef[];
  toolActivity: AiToolActivity[];
  aiRequestId: string | null;
  /** Aliases, so the caller can restore borrower names for this requester only. */
  redactor: Redactor;
  dataCategories: string[];
  usage: GeminiUsage;
}

function addUsage(total: GeminiUsage, next: GeminiUsage): GeminiUsage {
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    thoughtsTokens: total.thoughtsTokens + next.thoughtsTokens,
  };
}

const EMPTY_USAGE: GeminiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, thoughtsTokens: 0 };

/**
 * Models wrap JSON in ```json fences often enough that rejecting on them would
 * turn a correct answer into an error. Stripping is safe: only an enclosing
 * fence is removed, never anything inside the payload.
 */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The response contained no JSON object');
  return JSON.parse(body.slice(start, end + 1));
}

/** The repair path must not throw on a second malformed response. */
function parseJsonObjectSafe(text: string): unknown {
  try {
    return parseJsonObject(text);
  } catch {
    return null;
  }
}

const issueText = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

/** De-duplicates by name plus arguments, so a model asking twice pays once. */
const callSignature = (name: string, args: Record<string, unknown>): string => `${name} ${JSON.stringify(args)}`;

function dedupeSourceRefs(refs: AiSourceRef[]): AiSourceRef[] {
  const seen = new Map<string, AiSourceRef>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}:${ref.locator ?? ''}`;
    if (!seen.has(key)) seen.set(key, ref);
  }
  return [...seen.values()];
}

/**
 * Runs one AI feature end to end.
 *
 * Throws `AiError` on any failure, after recording telemetry, so a caller that
 * wants a degraded user-facing state can catch it and say honestly what
 * happened instead of inventing a result.
 */
export async function runAiFeature<T>(options: AiRunOptions<T>): Promise<AiRunResult<T>> {
  const startedAt = Date.now();
  const client = options.client ?? geminiClient();
  assertAiAvailable(client);

  const redactor = options.redactor ?? createRedactor();
  for (const category of options.dataCategories ?? []) redactor.note(category);

  const toolContext: ToolContext = {
    actor: options.actor,
    redactor,
    retriever: options.retriever ?? knowledgeRetriever(client),
  };

  if (options.prompt.length > env.AI_MAX_INPUT_CHARS) {
    throw aiInputTooLarge(options.prompt.length, env.AI_MAX_INPUT_CHARS);
  }

  const evidence: string[] = [...(options.evidence ?? [])];
  const toolActivity: AiToolActivity[] = [];
  const toolSourceRefs: AiSourceRef[] = [];
  let usage: GeminiUsage = { ...EMPTY_USAGE };
  let attempts = 0;
  let modelVersion = env.GEMINI_MODEL;

  const systemInstruction = buildSystemInstruction(options.feature);

  /**
   * The request plus every evidence block gathered so far, as one user turn.
   *
   * Rebuilt rather than appended to: the provider-neutral content shape has no
   * function-call part to replay, and a single delimited turn keeps the fence
   * structure the system instruction describes actually true.
   */
  const buildContents = (): AiContent[] => {
    const blocks = evidence.length ? `\n\n${evidence.join('\n\n')}` : '';
    return [
      {
        role: 'user',
        parts: [{ text: `<<<USER REQUEST\n${options.prompt}\nUSER REQUEST>>>${blocks}\n\n${GROUNDING_REMINDER}` }],
      },
    ];
  };

  const allSourceRefs = (): AiSourceRef[] => dedupeSourceRefs([...(options.knownSourceRefs ?? []), ...toolSourceRefs]);

  const record = (status: AiRequestStatus, errorCode: string | null, groundingRejected = false): Promise<string | null> =>
    recordAiRequest({
      organizationId: options.actor.organizationId,
      feature: options.feature,
      status,
      actor: options.actor,
      model: modelVersion,
      latencyMs: Date.now() - startedAt,
      attempts,
      usage,
      toolsUsed: toolActivity.map((activity) => activity.tool),
      toolCalls: toolActivity.length,
      sourceRefs: allSourceRefs(),
      dataCategoriesSent: redactor.dataCategories,
      redactionProfile: redactor.profile,
      groundingRejected,
      errorCode,
      conversationId: options.conversationId ?? null,
      requestId: options.requestId ?? null,
    });

  /** Records telemetry, logs a redacted reason, and ends the request. */
  const fail = async (error: AiError, status: AiRequestStatus, groundingRejected = false): Promise<never> => {
    await record(status, error.code, groundingRejected);
    logger.warn({ feature: options.feature, code: error.code, reason: toLogSafe(error.message, 200) }, 'AI request failed');
    throw error;
  };

  const blocked = (): AiError =>
    new AiError('AI_UNAVAILABLE', 'The provider blocked this request before generating a response.');

  try {
    // -- Phase 1: gather evidence through the allowlisted read-only tools -----
    if (options.allowTools) {
      const declarations = toolDeclarations();
      const executed = new Set<string>();

      for (let round = 0; round < env.AI_MAX_TOOL_ROUNDS; round += 1) {
        const gathered = await client.generate({
          model: env.GEMINI_MODEL,
          contents: buildContents(),
          systemInstruction,
          functionDeclarations: declarations,
          toolChoice: 'AUTO',
          temperature: options.temperature ?? 0.2,
          timeoutMs: env.AI_TIMEOUT_MS,
        });
        attempts += gathered.attempts;
        usage = addUsage(usage, gathered.usage);
        if (gathered.modelVersion) modelVersion = gathered.modelVersion;
        if (gathered.blocked) return await fail(blocked(), 'FAILED');
        if (gathered.functionCalls.length === 0) break;

        let progressed = false;
        for (const call of gathered.functionCalls) {
          const signature = callSignature(call.name, call.args);
          if (executed.has(signature)) continue;
          executed.add(signature);
          progressed = true;

          const result = await executeTool(toolContext, call.name, call.args);
          toolActivity.push({
            tool: result.name,
            label: result.outcome === 'SUCCEEDED' ? result.detail : TOOL_LABELS[call.name] ?? 'Gathering evidence',
            status: result.outcome,
            durationMs: result.durationMs,
            ...(result.outcome === 'SUCCEEDED' ? {} : { detail: result.detail }),
          });
          if (result.evidence) evidence.push(result.evidence);
          toolSourceRefs.push(...result.sourceRefs);
        }
        // Every requested call was a repeat, so the model is looping. Stop and
        // synthesise from what is on the table rather than spend the budget.
        if (!progressed) break;
      }
    }

    // -- Phase 2: synthesise a schema-constrained answer ----------------------
    // No tools here: the moment the model writes figures is the moment it must
    // not be able to reach for anything else.
    const synthesis = await client.generate({
      model: env.GEMINI_MODEL,
      contents: buildContents(),
      systemInstruction,
      responseSchema: responseSchemaFor(options.feature),
      toolChoice: 'NONE',
      temperature: options.temperature ?? 0.2,
      timeoutMs: env.AI_TIMEOUT_MS,
    });
    attempts += synthesis.attempts;
    usage = addUsage(usage, synthesis.usage);
    if (synthesis.modelVersion) modelVersion = synthesis.modelVersion;

    if (synthesis.blocked) return await fail(blocked(), 'FAILED');
    if (!synthesis.text) {
      return await fail(
        aiEvidenceMissing(`The model returned no content (finish reason: ${synthesis.finishReason ?? 'unknown'})`),
        'FAILED',
      );
    }

    // -- Phase 3: validate, repair once, then ground --------------------------
    const first = options.schema.safeParse(parseJsonObjectSafe(synthesis.text));
    let value: T;
    let status: AiRequestStatus = 'SUCCEEDED';

    if (first.success) {
      value = first.data;
    } else {
      const repair = await client.generate({
        model: env.GEMINI_MODEL,
        contents: [
          ...buildContents(),
          { role: 'model', parts: [{ text: synthesis.text }] },
          { role: 'user', parts: [{ text: buildRepairInstruction(issueText(first.error)) }] },
        ],
        systemInstruction,
        responseSchema: responseSchemaFor(options.feature),
        toolChoice: 'NONE',
        temperature: 0,
        timeoutMs: env.AI_TIMEOUT_MS,
      });
      attempts += repair.attempts;
      usage = addUsage(usage, repair.usage);
      if (repair.modelVersion) modelVersion = repair.modelVersion;

      const second = repair.text ? options.schema.safeParse(parseJsonObjectSafe(repair.text)) : null;
      if (!second?.success) {
        const issues = second ? issueText(second.error) : issueText(first.error);
        return await fail(aiSchemaInvalid(issues), 'SCHEMA_INVALID');
      }
      value = second.data;
      status = 'SCHEMA_REPAIRED';
    }

    if (STRICT_GROUNDING.has(options.feature)) {
      const ungrounded = findUngroundedClaimsInValue(value, evidence);
      if (ungrounded.length > 0) return await fail(aiGroundingRejected(ungrounded), 'FAILED', true);
    }

    const aiRequestId = await record(status, null);
    return {
      result: value,
      status,
      model: modelVersion,
      latencyMs: Date.now() - startedAt,
      evidence,
      sourceRefs: allSourceRefs(),
      toolActivity,
      aiRequestId,
      redactor,
      dataCategories: redactor.dataCategories,
      usage,
    };
  } catch (error) {
    // `fail` already recorded and logged what it threw; pass it straight through.
    if (error instanceof AiError) throw error;
    // Anything else is a transport failure the client's retry layer already
    // exhausted, or a bug. The user gets a stable code and the detail goes to
    // the log rather than into a prompt or a response body.
    logger.error({ err: error, feature: options.feature }, 'AI request failed unexpectedly');
    await record('FAILED', 'AI_UNAVAILABLE');
    throw new AiError('AI_UNAVAILABLE', 'The AI service could not complete this request. Please try again.');
  }
}

export { TOOL_LABELS };
