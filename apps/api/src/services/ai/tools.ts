/**
 * The copilot's allowlisted tools.
 *
 * Eight functions, all read-only, all listed here and nowhere else. The model
 * can only call what is registered in `AI_TOOLS`; there is no generic execute,
 * no SQL, no filesystem, no HTTP, and no tool that approves, overrides, edits an
 * assumption or computes an authoritative ECL. "The model cannot mutate
 * anything" is therefore a property of this registry rather than a request we
 * make of the model in the system prompt.
 *
 * Two invariants every tool upholds on its own, because a route-level check
 * would leave the tool itself unsafe to reuse:
 *
 *   - **Organization scope.** The organization id is taken from the
 *     authenticated actor's context and is *not* a parameter the model can
 *     supply. There is no argument name that would let a prompt reach another
 *     institution's portfolio; the worst it can do is ask for an id that does
 *     not exist here, and get a not-found.
 *   - **Permission.** Each tool names the permission its data requires and
 *     checks it before querying. An auditor can read a portfolio summary but
 *     the tool that exposes import mapping data still asks for the permission
 *     the rest of the import surface asks for.
 */
import {
  exceptionListQuerySchema,
  listQuerySchema,
  permissionsForRole,
  type AiSourceRef,
  type RoleName,
} from '@eclens/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { HttpError, forbidden } from '../../utils/httpError';
import { getExceptionSummary, listExceptions } from '../exceptions.service';
import { getExposureDetail, getPortfolioSummary } from '../portfolio.service';
import { getImportIssues, listImportBatches } from '../imports.service';
import { getRun, getRunResultDetail } from '../runs.service';
import { getScenarioSet } from '../governance.service';
import {
  compareRuns,
  findSnapshotRow,
  getScenarioComparison,
  getStageMigration,
  latestResultBearingRunFor,
  latestRunIdForExposure,
} from '../analytics.service';
import { renderChunkAsEvidence, type KnowledgeRetriever } from './retrieval';
import { toLogSafe, type DataCategory, type Redactor } from './redaction';
import type { AuditActor } from '../../lib/audit';
import type { AiFunctionDeclaration, AiJsonSchema } from './geminiClient';

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export interface ToolContext {
  actor: AuditActor;
  redactor: Redactor;
  retriever: KnowledgeRetriever;
}

export type ToolOutcome = 'SUCCEEDED' | 'FAILED' | 'REFUSED';

export interface ToolResult {
  name: string;
  outcome: ToolOutcome;
  durationMs: number;
  /** What the model is allowed to see. Empty on failure. */
  evidence: string;
  /** One-line description for the tool-activity indicator in the UI. */
  detail: string;
  sourceRefs: AiSourceRef[];
  dataCategories: DataCategory[];
}

export interface AiTool {
  name: string;
  permission: string;
  declaration: AiFunctionDeclaration;
  args: z.ZodTypeAny;
  execute(context: ToolContext, parsed: z.output<z.ZodTypeAny>): Promise<Omit<ToolResult, 'name' | 'outcome' | 'durationMs'>>;
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const optionalId = (description: string) => z.string().min(1).max(64).optional().describe(description);
const requiredId = (description: string) => z.string().min(1).max(64).describe(description);

const str = (description: string): AiJsonSchema => ({ type: 'STRING', description });
const optStr = (description: string): AiJsonSchema => ({ type: 'STRING', description, nullable: true });

function params(description: string, properties: Record<string, AiJsonSchema>, required: string[]): AiJsonSchema {
  return { type: 'OBJECT', description, properties, required, propertyOrdering: required };
}

// ---------------------------------------------------------------------------
// Evidence rendering
// ---------------------------------------------------------------------------

/**
 * Walks a record replacing borrower names with the request's aliases.
 *
 * Keyed rather than pattern-matched on purpose: `name` alone is far too broad
 * (scenario names, segment names, configuration names are all legitimate
 * evidence), so only the two places a counterparty's legal name actually lives
 * are rewritten.
 */
function redactRecord(value: unknown, redactor: Redactor): unknown {
  if (Array.isArray(value)) return value.map((item) => redactRecord(item, redactor));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'borrowerName' && typeof item === 'string') {
      out[key] = redactor.pseudonymize(item);
      continue;
    }
    if (key === 'borrower' && item && typeof item === 'object' && !Array.isArray(item)) {
      const borrower = item as Record<string, unknown>;
      out[key] = {
        ...borrower,
        ...(typeof borrower.name === 'string' ? { name: redactor.pseudonymize(borrower.name) } : {}),
      };
      continue;
    }
    out[key] = redactRecord(item, redactor);
  }
  return out;
}

const TRUNCATION_MARKER = '\n…[evidence truncated to stay within the request size limit]';

/**
 * Serializes and bounds one block of evidence.
 *
 * The bound is per block rather than global: a single oversized result would
 * otherwise consume the whole evidence budget and starve the other blocks,
 * leaving the model with one deep record and no context.
 *
 * Exported because the feature layer supplies its own deterministic evidence —
 * a batch's column headers, a document's extracted text — and that evidence
 * must look exactly like tool output. One fence format means the system
 * instruction's promise about `<<<EVIDENCE …>>>` blocks stays true everywhere.
 */
export function renderEvidence(label: string, value: unknown, redactor: Redactor, limit = env.AI_MAX_EVIDENCE_CHARS): string {
  const json = JSON.stringify(redactRecord(value, redactor), null, 1);
  const body = json.length > limit ? `${json.slice(0, limit)}${TRUNCATION_MARKER}` : json;
  return `<<<EVIDENCE ${label}\n${body}\nEVIDENCE ${label}>>>`;
}

export const sourceRef = (kind: AiSourceRef['kind'], id: string, label?: string, locator?: string): AiSourceRef => ({
  kind,
  id,
  ...(label ? { label } : {}),
  ...(locator ? { locator } : {}),
});

// ---------------------------------------------------------------------------
// The eight tools
// ---------------------------------------------------------------------------

const portfolioSummaryTool: AiTool = {
  name: 'getPortfolioSummary',
  permission: 'portfolio:read',
  declaration: {
    name: 'getPortfolioSummary',
    description:
      'Portfolio-level totals and distribution as stored: gross carrying amount, EAD, loss allowance, coverage ratio, stage buckets and shares, segment breakdown, the high-risk list, recent runs, open exception counts and the calculation lineage. Reads the latest completed run unless a snapshot is named.',
    parameters: params('Optional filters.', { snapshotId: optStr('Snapshot public id to read instead of the latest.') }, []),
  },
  args: z.object({ snapshotId: optionalId('Snapshot public id.') }),
  async execute({ actor, redactor }, parsed) {
    const summary = await getPortfolioSummary(actor.organizationId, parsed.snapshotId);
    redactor.note('PORTFOLIO_AGGREGATES', 'EXPOSURE_BALANCES', 'RUN_RESULTS');
    return {
      // The full trend history is noise for a summary answer and burns budget.
      evidence: renderEvidence('PORTFOLIO_SUMMARY', { ...summary, trend: summary.trend.slice(-6) }, redactor),
      detail: `Portfolio summary for ${summary.snapshotLabel}`,
      sourceRefs: [
        sourceRef('PORTFOLIO_SUMMARY', summary.snapshotId, summary.snapshotLabel, summary.asOf),
        ...summary.recentRuns.map((run) => sourceRef('RUN', run.publicId, undefined, run.runDate)),
      ],
      dataCategories: ['PORTFOLIO_AGGREGATES', 'EXPOSURE_BALANCES', 'RUN_RESULTS'],
    };
  },
};

const exposureDetailsTool: AiTool = {
  name: 'getExposureDetails',
  permission: 'portfolio:read',
  declaration: {
    name: 'getExposureDetails',
    description:
      'Everything stored about one exposure: contract terms, balances, PD term inputs, LGD, collateral, EAD profile, flags such as days past due and forbearance, the live staging assessment with its triggered rules, any stage override, and the latest calculated result. Borrower names are returned as aliases.',
    parameters: params('Which exposure.', { exposureId: str('Exposure public id, e.g. EXP-XXXX.') }, ['exposureId']),
  },
  args: z.object({ exposureId: requiredId('Exposure public id.') }),
  async execute({ actor, redactor }, parsed) {
    const detail = await getExposureDetail(actor.organizationId, parsed.exposureId);
    redactor.note('EXPOSURE_IDENTIFIERS', 'EXPOSURE_BALANCES', 'STAGING_OVERRIDES');
    const { publicId, segment } = detail.exposure;
    return {
      evidence: renderEvidence(`EXPOSURE ${publicId}`, detail, redactor),
      detail: `Exposure ${publicId} (${segment})`,
      sourceRefs: [sourceRef('EXPOSURE', publicId, segment)],
      dataCategories: ['EXPOSURE_IDENTIFIERS', 'EXPOSURE_BALANCES', 'STAGING_OVERRIDES'],
    };
  },
};

const calculationTraceTool: AiTool = {
  name: 'getCalculationTrace',
  permission: 'portfolio:read',
  declaration: {
    name: 'getCalculationTrace',
    description:
      'The persisted calculation trace for one exposure in one run: the staging decision, the horizon, every scenario with its weight and weighted contribution, each calculation period with marginal PD, LGD, EAD, discount factor, expected loss and the formula string, the educational approximation, and the lineage naming the exact configuration versions used. This is the authoritative record for explaining an ECL.',
    parameters: params('Which exposure and run.', {
      exposureId: str('Exposure public id.'),
      runId: optStr('Run public id. Omit to use the latest run that has results for this exposure.'),
    }, ['exposureId']),
  },
  args: z.object({ exposureId: requiredId('Exposure public id.'), runId: optionalId('Run public id.') }),
  async execute({ actor, redactor }, parsed) {
    const { exposureId, runId: requestedRunId } = parsed as { exposureId: string; runId?: string };
    let runId = requestedRunId;

    if (!runId) {
      runId = (await latestRunIdForExposure(actor.organizationId, exposureId)) ?? undefined;
      if (!runId) {
        return {
          evidence: renderEvidence(
            `CALCULATION_TRACE ${exposureId}`,
            { exposureId, run: null, note: 'No completed run has stored a result for this exposure, so there is no calculation trace to explain.' },
            redactor,
          ),
          detail: `No calculated result exists for exposure ${exposureId}`,
          sourceRefs: [sourceRef('EXPOSURE', exposureId)],
          dataCategories: ['RUN_RESULTS'],
        };
      }
    }

    const detail = await getRunResultDetail(actor.organizationId, runId, exposureId);
    redactor.note('RUN_RESULTS', 'EXPOSURE_BALANCES', 'EXPOSURE_IDENTIFIERS');
    return {
      // A trace is period-by-period, so it gets more budget than a summary tool.
      evidence: renderEvidence(`CALCULATION_TRACE ${runId}`, detail, redactor, Math.floor(env.AI_MAX_EVIDENCE_CHARS * 1.5)),
      detail: `Calculation trace for ${exposureId} in run ${runId}`,
      sourceRefs: [sourceRef('RUN', runId), sourceRef('EXPOSURE', exposureId)],
      dataCategories: ['RUN_RESULTS', 'EXPOSURE_BALANCES', 'EXPOSURE_IDENTIFIERS'],
    };
  },
};

const compareRunsTool: AiTool = {
  name: 'compareRuns',
  permission: 'portfolio:read',
  declaration: {
    name: 'compareRuns',
    description:
      'Compares two stored runs: total allowance on each side with the change and percentage, whether the two used the same snapshot, model configuration, scenario set and staging rule set, the largest exposure-level increases and decreases, the stage migration matrix, and how many exposures matched. Reports honestly when the runs are not comparable.',
    parameters: params('The two runs.', {
      baseRunId: str('Public id of the earlier or reference run.'),
      comparisonRunId: str('Public id of the run to compare against it.'),
    }, ['baseRunId', 'comparisonRunId']),
  },
  args: z.object({
    baseRunId: requiredId('Base run public id.'),
    comparisonRunId: requiredId('Comparison run public id.'),
  }),
  async execute({ actor, redactor }, parsed) {
    const comparison = await compareRuns(actor.organizationId, parsed.baseRunId as string, parsed.comparisonRunId as string);
    redactor.note('RUN_RESULTS', 'PORTFOLIO_AGGREGATES');
    return {
      evidence: renderEvidence('RUN_COMPARISON', comparison, redactor),
      detail: `Compared run ${comparison.baseRun.publicId} with ${comparison.comparisonRun.publicId}`,
      sourceRefs: [
        sourceRef('RUN', comparison.baseRun.publicId, comparison.baseRun.label),
        sourceRef('RUN', comparison.comparisonRun.publicId, comparison.comparisonRun.label),
      ],
      dataCategories: ['RUN_RESULTS', 'PORTFOLIO_AGGREGATES'],
    };
  },
};

const scenarioComparisonTool: AiTool = {
  name: 'getScenarioComparison',
  permission: 'scenario:read',
  declaration: {
    name: 'getScenarioComparison',
    description:
      'Per-scenario contribution to one run\'s total allowance: each scenario\'s weight, PD and LGD multipliers, horizon, unweighted and weighted ECL, its share of the total weighted allowance, the average cumulative PD in horizon, the weight sum, and the scenario set the run locked.',
    parameters: params('Which run.', { runId: str('Run public id.') }, ['runId']),
  },
  args: z.object({ runId: requiredId('Run public id.') }),
  async execute({ actor, redactor }, parsed) {
    const runId = parsed.runId as string;
    const [comparison, run] = await Promise.all([
      getScenarioComparison(actor.organizationId, runId),
      getRun(actor.organizationId, runId),
    ]);
    // The locked copy is what this run's allowance was actually computed from.
    const scenarioSet = run.lockedScenarioSet ?? (await getScenarioSet(actor.organizationId, run.scenarioSetId));
    redactor.note('SCENARIO_WEIGHTS', 'RUN_RESULTS');
    return {
      evidence: renderEvidence('SCENARIO_COMPARISON', { ...comparison, lockedScenarioSet: scenarioSet }, redactor),
      detail: `Scenario comparison for run ${comparison.runPublicId}`,
      sourceRefs: [
        sourceRef('RUN', comparison.runPublicId, comparison.runLabel),
        sourceRef('SCENARIO_SET', run.scenarioSetId, `${run.scenarioSetName} ${run.scenarioSetVersion}`),
      ],
      dataCategories: ['SCENARIO_WEIGHTS', 'RUN_RESULTS'],
    };
  },
};

const stageMigrationTool: AiTool = {
  name: 'getStageMigration',
  permission: 'portfolio:read',
  declaration: {
    name: 'getStageMigration',
    description:
      'How exposures moved between stage 1, 2 and 3 across two snapshots, matched on exposure public id: the from/to counts and carrying amount for each movement, stage populations on each side, the net stage 3 change, how many exposures matched, and explicit limitations when a snapshot has no completed run or the two portfolios do not overlap.',
    parameters: params('The two snapshots.', {
      fromSnapshotId: str('Public id of the earlier snapshot.'),
      toSnapshotId: str('Public id of the later snapshot.'),
    }, ['fromSnapshotId', 'toSnapshotId']),
  },
  args: z.object({
    fromSnapshotId: requiredId('Earlier snapshot public id.'),
    toSnapshotId: requiredId('Later snapshot public id.'),
  }),
  async execute({ actor, redactor }, parsed) {
    const migration = await getStageMigration(
      actor.organizationId,
      parsed.fromSnapshotId as string,
      parsed.toSnapshotId as string,
    );
    redactor.note('STAGE_MIGRATION', 'RUN_RESULTS');
    return {
      evidence: renderEvidence('STAGE_MIGRATION', migration, redactor),
      detail: `Stage migration ${migration.fromSnapshot.publicId} → ${migration.toSnapshot.publicId}`,
      sourceRefs: [
        sourceRef('SNAPSHOT', migration.fromSnapshot.publicId, migration.fromSnapshot.label),
        sourceRef('SNAPSHOT', migration.toSnapshot.publicId, migration.toSnapshot.label),
      ],
      dataCategories: ['STAGE_MIGRATION', 'RUN_RESULTS'],
    };
  },
};

const dataQualityTool: AiTool = {
  name: 'getDataQualityIssues',
  permission: 'portfolio:read',
  declaration: {
    name: 'getDataQualityIssues',
    description:
      'Validation issues and exceptions for one import batch or one snapshot. For a batch: every issue with its row, field, raw value, code, severity and suggested correction, plus the quarantined rows. For a snapshot: the exceptions raised by that snapshot\'s latest result-bearing run, with counts by kind and severity — and an explicit statement when the snapshot has no completed run, in which case nothing is counted. Names at least one of importBatchId or snapshotId.',
    parameters: params('Which data to inspect.', {
      importBatchId: optStr('Import batch public id, e.g. IMP-XXXX.'),
      snapshotId: optStr('Snapshot public id; its latest completed run\'s exceptions are returned.'),
      severity: optStr('Restrict exceptions to one severity: LOW, MEDIUM or HIGH.'),
    }, []),
  },
  args: z.object({
    importBatchId: optionalId('Import batch public id.'),
    snapshotId: optionalId('Snapshot public id.'),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  }),
  async execute({ actor, redactor }, parsed) {
    const { importBatchId, snapshotId, severity } = parsed as {
      importBatchId?: string;
      snapshotId?: string;
      severity?: 'LOW' | 'MEDIUM' | 'HIGH';
    };

    if (!importBatchId && !snapshotId) {
      const [batches, summary] = await Promise.all([
        listImportBatches(actor.organizationId, listQuerySchema.parse({ page: 1, pageSize: 10 })),
        getExceptionSummary(actor.organizationId),
      ]);
      redactor.note('DATA_QUALITY_ISSUES');
      return {
        evidence: renderEvidence('DATA_QUALITY_OVERVIEW', { recentImportBatches: batches.items, exceptionSummary: summary }, redactor),
        detail: 'Data-quality overview: recent import batches and exception counts',
        sourceRefs: batches.items.map((batch) => sourceRef('IMPORT_BATCH', batch.publicId, batch.fileName)),
        dataCategories: ['DATA_QUALITY_ISSUES'],
      };
    }

    if (importBatchId) {
      const issues = await getImportIssues(actor.organizationId, importBatchId);
      redactor.note('DATA_QUALITY_ISSUES', 'EXPOSURE_IDENTIFIERS');
      return {
        evidence: renderEvidence(`IMPORT_ISSUES ${importBatchId}`, issues, redactor),
        detail: `${issues.issues.length} validation issue(s) and ${issues.quarantinedRows.length} quarantined row(s) in ${importBatchId}`,
        sourceRefs: [sourceRef('IMPORT_BATCH', importBatchId, undefined, `${issues.issues.length} issues`)],
        dataCategories: ['DATA_QUALITY_ISSUES', 'EXPOSURE_IDENTIFIERS'],
      };
    }

    // Exceptions are raised by a *run*, and a snapshot may have no run that
    // produced results. Resolving that here rather than returning the whole
    // queue is what keeps a count the model quotes tied to the snapshot named.
    const snapshot = await findSnapshotRow(actor.organizationId, snapshotId as string);
    const snapshotRef = sourceRef('SNAPSHOT', snapshot.publicId, snapshot.label, snapshot.asOfDate.toISOString().slice(0, 10));
    const run = await latestResultBearingRunFor(actor.organizationId, snapshot.id);

    if (!run) {
      redactor.note('DATA_QUALITY_ISSUES');
      return {
        evidence: renderEvidence(
          `SNAPSHOT_EXCEPTIONS ${snapshot.publicId}`,
          {
            snapshot,
            run: null,
            exceptions: null,
            note: 'This snapshot has no completed run, so no run-raised exceptions exist for it. Nothing was counted.',
          },
          redactor,
        ),
        detail: `Snapshot ${snapshot.publicId} has no completed run`,
        sourceRefs: [snapshotRef],
        dataCategories: ['DATA_QUALITY_ISSUES'],
      };
    }

    const exceptions = await listExceptions(
      actor.organizationId,
      exceptionListQuerySchema.parse({
        page: 1,
        pageSize: 50,
        runId: run.publicId,
        ...(severity ? { severity } : {}),
      }),
    );
    redactor.note('DATA_QUALITY_ISSUES', 'EXPOSURE_IDENTIFIERS');
    return {
      evidence: renderEvidence(
        `SNAPSHOT_EXCEPTIONS ${snapshot.publicId}`,
        {
          snapshot,
          run: { publicId: run.publicId, status: run.status, runDate: run.runDate },
          exceptions,
        },
        redactor,
      ),
      detail: `${exceptions.meta.totalItems} exception(s) raised by run ${run.publicId} on snapshot ${snapshot.publicId}`,
      sourceRefs: [snapshotRef, sourceRef('RUN', run.publicId)],
      dataCategories: ['DATA_QUALITY_ISSUES', 'EXPOSURE_IDENTIFIERS'],
    };
  },
};

const governanceKnowledgeTool: AiTool = {
  name: 'searchGovernanceKnowledge',
  permission: 'document:read',
  declaration: {
    name: 'searchGovernanceKnowledge',
    description:
      'Searches this organisation\'s governance library: uploaded credit-risk policies, borrower financial documents and concise IFRS 9 orientation notes. Returns the most relevant passages with the document name, page number and a short quotation so a claim can be cited. Use it for what the policy or the standard requires — never for portfolio figures, which come from the other tools.',
    parameters: params('What to look for.', {
      query: str('A short natural-language query, e.g. "SICR quantitative threshold policy".'),
      category: optStr('Restrict to one category: POLICY, BORROWER_FINANCIAL, GUIDANCE, SUPPORTING or OTHER.'),
    }, ['query']),
  },
  args: z.object({
    query: z.string().min(2).max(400),
    category: z.enum(['POLICY', 'BORROWER_FINANCIAL', 'GUIDANCE', 'SUPPORTING', 'OTHER']).optional(),
  }),
  async execute({ actor, redactor, retriever }, parsed) {
    const { query, category } = parsed as { query: string; category?: string };
    const chunks = await retriever.search({
      organizationId: actor.organizationId,
      query,
      topK: 5,
      ...(category ? { categories: [category] } : {}),
    });
    redactor.note('GOVERNANCE_KNOWLEDGE', 'DOCUMENT_TEXT');

    if (chunks.length === 0) {
      return {
        evidence: renderEvidence('GOVERNANCE_KNOWLEDGE', { found: 0, note: 'No governance document in this organisation matches that query.' }, redactor),
        detail: 'No governance passages matched',
        sourceRefs: [],
        dataCategories: ['GOVERNANCE_KNOWLEDGE'],
      };
    }

    const evidence = chunks.map(renderChunkAsEvidence).join('\n\n');
    return {
      evidence: redactor.applyToText(evidence.slice(0, env.AI_MAX_EVIDENCE_CHARS)),
      detail: `${chunks.length} governance passage(s) matched`,
      sourceRefs: chunks.map((chunk) =>
        sourceRef('DOCUMENT', chunk.documentPublicId, chunk.documentName, chunk.page ? `page ${chunk.page}` : `chunk ${chunk.chunkOrdinal}`),
      ),
      dataCategories: ['GOVERNANCE_KNOWLEDGE', 'DOCUMENT_TEXT'],
    };
  },
};

export const AI_TOOLS: readonly AiTool[] = [
  portfolioSummaryTool,
  exposureDetailsTool,
  calculationTraceTool,
  compareRunsTool,
  scenarioComparisonTool,
  stageMigrationTool,
  dataQualityTool,
  governanceKnowledgeTool,
];

export const AI_TOOL_NAMES: readonly string[] = AI_TOOLS.map((tool) => tool.name);

export function toolDeclarations(): AiFunctionDeclaration[] {
  return AI_TOOLS.map((tool) => tool.declaration);
}

const TOOL_BY_NAME = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Authorization and execution
// ---------------------------------------------------------------------------

/**
 * The permission check every AI entry point makes, tool or feature.
 *
 * `AuditActor.role` is Prisma's `RoleName` while `permissionsForRole` takes the
 * shared package's; the two are nominally distinct types over the same string
 * union, so the cast is required and mirrors `middleware/auth.ts`. An unknown
 * role yields no permissions and therefore fails closed.
 */
export function assertActorPermission(actor: AuditActor, permission: string, what: string): void {
  const held = permissionsForRole(actor.role as RoleName);
  if (!held.includes(permission)) {
    throw forbidden(`The '${permission}' permission is required to ${what}, which the ${actor.role} role does not hold`);
  }
}

/**
 * Checked inside the tool, not only at the route.
 *
 * A route-level gate answers "may this user call the copilot". This answers the
 * narrower question "may this user see the data this particular tool returns",
 * which is the one that matters if a tool is ever reused from a different
 * entry point.
 */
export function assertToolPermission(context: ToolContext, tool: AiTool): void {
  assertActorPermission(context.actor, tool.permission, `call the ${tool.name} tool`);
}

/**
 * Runs one tool call from the model.
 *
 * Never throws. An authorization refusal, a not-found or a validation failure
 * becomes a structured result the loop can hand back to the model, which can
 * then correct its arguments or answer without that evidence. Letting a single
 * bad tool call abort the whole request would make the copilot fragile in
 * exactly the situations where it is most useful.
 */
export async function executeTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const tool = TOOL_BY_NAME.get(name);

  if (!tool) {
    return {
      name,
      outcome: 'REFUSED',
      durationMs: Date.now() - startedAt,
      evidence: '',
      detail: `"${toLogSafe(name, 40)}" is not one of the ${AI_TOOLS.length} permitted tools`,
      sourceRefs: [],
      dataCategories: [],
    };
  }

  try {
    assertToolPermission(context, tool);
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'Not permitted';
    logger.warn({ tool: name, role: context.actor.role }, 'AI tool refused on permission');
    return {
      name,
      outcome: 'REFUSED',
      durationMs: Date.now() - startedAt,
      evidence: '',
      detail: message,
      sourceRefs: [],
      dataCategories: [],
    };
  }

  const parsedArgs = tool.args.safeParse(args ?? {});
  if (!parsedArgs.success) {
    return {
      name,
      outcome: 'FAILED',
      durationMs: Date.now() - startedAt,
      evidence: '',
      detail: `Invalid arguments: ${parsedArgs.error.issues.map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}`).join('; ')}`,
      sourceRefs: [],
      dataCategories: [],
    };
  }

  try {
    const result = await tool.execute(context, parsedArgs.data);
    return { name, outcome: 'SUCCEEDED', durationMs: Date.now() - startedAt, ...result };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        name,
        outcome: 'FAILED',
        durationMs: Date.now() - startedAt,
        evidence: '',
        detail: error.message,
        sourceRefs: [],
        dataCategories: [],
      };
    }
    // Anything unexpected is logged in full but reported to the model only as a
    // generic failure: a stack trace in a prompt is both useless and leaky.
    logger.error({ err: error, tool: name }, 'AI tool failed unexpectedly');
    return {
      name,
      outcome: 'FAILED',
      durationMs: Date.now() - startedAt,
      evidence: '',
      detail: 'This tool could not complete. Answer without it, or say the evidence is unavailable.',
      sourceRefs: [],
      dataCategories: [],
    };
  }
}
