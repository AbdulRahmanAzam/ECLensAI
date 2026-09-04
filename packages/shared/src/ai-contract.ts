/**
 * The Step 3 AI wire contract.
 *
 * One rule shapes every type in this file: **the model proposes, the engine
 * disposes.** Gemini may explain, classify, map and summarise, but every figure
 * it returns must have arrived inside the evidence we handed it, and every
 * change it suggests must be confirmed by a person through an existing,
 * permissioned, audited endpoint. Nothing here can mutate a stage, a run, an
 * assumption or a calculation.
 *
 * Two consequences are visible in the shapes below:
 *
 *   1. Every answer carries `sourceRefs` and `caveats`. A response that cannot
 *      cite where a number came from is not a valid response.
 *   2. Proposals carry `requiresApproval: true` as a *literal*, so a client
 *      cannot forget that a scenario draft or an extracted risk signal is inert
 *      until a human accepts it.
 *
 * Confidence is a plain 0..1 float rather than a decimal string: it is a model
 * self-report about prose, not a financial quantity, and it is never summed.
 * Money and rates continue to cross the wire as decimal strings exactly as in
 * `api-contract.ts`.
 */
import { z } from 'zod';
import { listQuerySchema, type Paginated } from './api-contract';
import type { PortfolioField } from './ingest/columns';

/** Bumped whenever a response shape below changes, and stored on every request. */
export const AI_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Features, availability and citations
// ---------------------------------------------------------------------------

export const AI_FEATURES = [
  'PORTFOLIO_COPILOT',
  'EXPLAIN_ECL',
  'IMPORT_MAPPING',
  'DATA_QUALITY_INVESTIGATION',
  'SCENARIO_DRAFT',
  'DOCUMENT_INTELLIGENCE',
  'EXECUTIVE_COMMENTARY',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_REQUEST_STATUSES = ['SUCCEEDED', 'SCHEMA_REPAIRED', 'SCHEMA_INVALID', 'FAILED', 'UNAVAILABLE'] as const;
export type AiRequestStatus = (typeof AI_REQUEST_STATUSES)[number];

export const AI_CONFIDENCE_LABELS = ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_EVIDENCE'] as const;
export type AiConfidenceLabel = (typeof AI_CONFIDENCE_LABELS)[number];

export const AI_SOURCE_REF_KINDS = [
  'RUN',
  'EXPOSURE',
  'SNAPSHOT',
  'IMPORT_BATCH',
  'SCENARIO_SET',
  'MODEL_CONFIGURATION',
  'EXCEPTION',
  'DOCUMENT',
  'PORTFOLIO_SUMMARY',
  'GOVERNANCE_GUIDANCE',
] as const;
export type AiSourceRefKind = (typeof AI_SOURCE_REF_KINDS)[number];

/**
 * Where a claim came from. `id` is a public identifier the user can open in the
 * app; `locator` narrows it further — a page number, a period index, a line.
 */
export interface AiSourceRef {
  kind: AiSourceRefKind;
  id: string;
  label?: string;
  locator?: string;
}

export const aiSourceRefSchema = z.object({
  kind: z.enum(AI_SOURCE_REF_KINDS),
  id: z.string().min(1).max(120),
  label: z.string().max(200).optional(),
  locator: z.string().max(120).optional(),
});

/**
 * Reported by `GET /api/v1/ai/status` so the UI states honestly whether the
 * assistant is live, rather than rendering a chat box that cannot answer.
 */
export interface AiAvailabilityRecord {
  available: boolean;
  model: string;
  /** Machine-readable: `NO_API_KEY`, `DISABLED`, `READY`. */
  reason: 'READY' | 'NO_API_KEY' | 'DISABLED';
  /** Human-readable one-liner the UI can show verbatim. */
  message: string;
  retrievalProvider: string;
  schemaVersion: string;
}

/**
 * The notice shown next to every AI answer.
 *
 * Shared rather than duplicated in the web bundle: a product that tells users an
 * answer is grounded in stored records has to say in the same breath that it can
 * still be wrong, and the two halves of that sentence should not be maintained
 * in two places that can drift.
 */
export const AI_DISCLAIMER =
  'AI can make mistakes. Figures are copied from this organisation’s stored records at their stored precision — verify against the cited source before relying on them. Nothing here changes a staging decision, approves a run, or edits a model assumption.';

/**
 * What the UI needs before it spends a single model call.
 *
 * Every `AiResponse` carries `availability`, but the copilot page has to render
 * an honest empty state on mount — before there is any answer to hang it on — and
 * the upload form has to know whether extraction will work while chunking and
 * citation will not. Without this the client would either call a model to
 * discover the model is absent, or guess from its own build-time env, which is
 * exactly the wrong place for an AI configuration fact.
 */
export interface AiStatusResponse {
  availability: AiAvailabilityRecord;
  features: AiFeature[];
  limits: {
    windowMs: number;
    maxRequestsPerWindow: number;
    /** Longest question the copilot accepts, in characters. */
    maxInputChars: number;
    maxOutputTokens: number;
    /** Largest accepted document upload, in bytes. */
    maxDocumentBytes: number;
  };
  /**
   * Always false, and reported rather than left implicit.
   *
   * A streamed answer reaches the screen token by token, so an ungrounded figure
   * would be visible before the grounding guard could withhold it. Validating
   * the whole response first costs latency and buys the guarantee, so the client
   * should not be left to infer whether streaming exists.
   */
  streaming: boolean;
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Feature 1 — Portfolio Copilot
// ---------------------------------------------------------------------------

/**
 * One tool the model asked for, in the language a risk analyst uses. Shown as a
 * progress indicator so a slow answer is legible rather than mysterious.
 */
export interface AiToolActivity {
  tool: string;
  label: string;
  status: 'CALLED' | 'SUCCEEDED' | 'FAILED' | 'REFUSED';
  durationMs: number;
  /** Present when the call was refused or failed, and safe to display. */
  detail?: string;
}

export interface CopilotAnswer {
  answer: string;
  evidence: string[];
  sourceRefs: AiSourceRef[];
  caveats: string[];
  suggestedQuestions: string[];
  confidenceLabel: AiConfidenceLabel;
}

export const copilotAnswerSchema = z.object({
  answer: z.string().min(1).max(4000),
  evidence: z.array(z.string().min(1).max(600)).max(12).default([]),
  sourceRefs: z.array(aiSourceRefSchema).max(20).default([]),
  caveats: z.array(z.string().min(1).max(400)).max(8).default([]),
  suggestedQuestions: z.array(z.string().min(3).max(160)).max(5).default([]),
  confidenceLabel: z.enum(AI_CONFIDENCE_LABELS).default('INSUFFICIENT_EVIDENCE'),
});

export interface CopilotTurnRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Assistant turns only. */
  parsed?: CopilotAnswer;
  toolActivity?: AiToolActivity[];
  status?: AiRequestStatus;
  latencyMs?: number;
  model?: string;
  /** Set when the model was unavailable, so the UI labels the reply as a demo. */
  degraded?: boolean;
  /** Assistant turns only: how this requester rated the answer, if they did. */
  feedbackVote?: 'UP' | 'DOWN' | null;
}

export interface CopilotThreadRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: CopilotTurnRecord[];
}

export interface CopilotQueryResponse {
  thread: CopilotThreadRecord;
  availability: AiAvailabilityRecord;
  /** Thumbs feedback target for the assistant turn just produced. */
  turnId: string;
}

export const copilotQueryRequestSchema = z.object({
  question: z.string().min(2, 'Ask a question of at least 2 characters').max(2000),
  threadId: z.string().max(64).optional(),
  /** Optional focus so "explain this" from a page carries its context. */
  runId: z.string().max(64).optional(),
  exposureId: z.string().max(64).optional(),
  snapshotId: z.string().max(64).optional(),
});
export type CopilotQueryRequest = z.infer<typeof copilotQueryRequestSchema>;

export const copilotFeedbackRequestSchema = z.object({
  vote: z.enum(['UP', 'DOWN']),
  comment: z.string().max(1000).optional(),
});
export type CopilotFeedbackRequest = z.infer<typeof copilotFeedbackRequestSchema>;

/**
 * A thread without its turns.
 *
 * The list endpoint backs a sidebar, and a sidebar needs a title and a date,
 * not the full text of every answer in every conversation. `CopilotThreadRecord`
 * stays the shape returned when one thread is actually opened.
 */
export interface CopilotThreadSummaryRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  /** True when at least one assistant turn was answered without the model. */
  hasDegradedTurn: boolean;
}

export interface CopilotThreadListResponse extends Paginated<CopilotThreadSummaryRecord> {
  availability: AiAvailabilityRecord;
}

export interface CopilotFeedbackResponse {
  turnId: string;
  vote: 'UP' | 'DOWN';
  comment: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Feature 2 — Explain This ECL
// ---------------------------------------------------------------------------

export interface EclExplanation {
  summary: string;
  stageExplanation: string;
  horizonExplanation: string;
  scenarioContributions: string[];
  keyParameters: string[];
  /**
   * The arithmetic reconciliation, in words, using only figures from the trace.
   * Each entry should read as "A + B = C" prose an auditor can replay.
   */
  reconciliation: string[];
  caveats: string[];
  sourceRefs: AiSourceRef[];
  confidenceLabel: AiConfidenceLabel;
}

export const eclExplanationSchema = z.object({
  summary: z.string().min(1).max(2000),
  stageExplanation: z.string().min(1).max(1200),
  horizonExplanation: z.string().min(1).max(1200),
  scenarioContributions: z.array(z.string().min(1).max(400)).max(12).default([]),
  keyParameters: z.array(z.string().min(1).max(300)).max(16).default([]),
  reconciliation: z.array(z.string().min(1).max(400)).max(16).default([]),
  caveats: z.array(z.string().min(1).max(400)).max(8).default([]),
  sourceRefs: z.array(aiSourceRefSchema).max(20).default([]),
  confidenceLabel: z.enum(AI_CONFIDENCE_LABELS).default('INSUFFICIENT_EVIDENCE'),
});

export const explainEclRequestSchema = z.object({
  exposureId: z.string().min(1).max(64),
  /** Omitted on the exposure page, where the latest result is explained. */
  runId: z.string().max(64).optional(),
});
export type ExplainEclRequest = z.infer<typeof explainEclRequestSchema>;

// ---------------------------------------------------------------------------
// Feature 3 — Smart Import Mapper
// ---------------------------------------------------------------------------

export const AI_MAPPING_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNSURE'] as const;
export type AiMappingConfidence = (typeof AI_MAPPING_CONFIDENCE_LEVELS)[number];

export interface ImportMappingSuggestion {
  sourceColumn: string;
  /** Null when the model believes the column has no canonical counterpart. */
  targetField: PortfolioField | null;
  confidence: number;
  confidenceLevel: AiMappingConfidence;
  /** e.g. `PERCENT`, `CURRENCY_PKR`, `DATE_ISO`, `COUNT`, `RATE_DECIMAL`. */
  detectedUnit: string;
  rationale: string;
  warnings: string[];
}

export interface ImportMappingSuggestionSet {
  suggestions: ImportMappingSuggestion[];
  /** The deterministic engine's own mapping, shown beside the AI's for contrast. */
  deterministicSuggestions: Array<{ field: PortfolioField; header: string | null; confidence: number }>;
  unmappedColumns: string[];
  missingRequiredFields: PortfolioField[];
  caveats: string[];
  requiresApproval: true;
}

export const importMappingSuggestionSchema = z.object({
  sourceColumn: z.string().min(1).max(200),
  targetField: z.string().max(64).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  confidenceLevel: z.enum(AI_MAPPING_CONFIDENCE_LEVELS).default('UNSURE'),
  detectedUnit: z.string().max(40).default('UNKNOWN'),
  rationale: z.string().min(1).max(400),
  warnings: z.array(z.string().min(1).max(300)).max(6).default([]),
});

export const aiModelImportMappingSchema = z.object({
  suggestions: z.array(importMappingSuggestionSchema).min(1).max(80),
  caveats: z.array(z.string().min(1).max(400)).max(8).default([]),
});

export const aiImportMappingRequestSchema = z.object({
  batchId: z.string().min(1).max(64),
});
export type AiImportMappingRequest = z.infer<typeof aiImportMappingRequestSchema>;

// ---------------------------------------------------------------------------
// Feature 4 — Data Quality Investigator
// ---------------------------------------------------------------------------

export interface DataQualityPattern {
  /** A short machine-stable slug, e.g. `PERCENT_AS_WHOLE_NUMBER`. */
  code: string;
  title: string;
  explanation: string;
  affectedCount: number;
  /** Bounded sample; never the whole quarantine. */
  examples: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DataQualityCorrection {
  patternCode: string;
  field: string;
  suggestedCorrection: string;
  rationale: string;
  /** True when applying it would change a persisted figure. */
  destructive: boolean;
}

export interface DataQualityInvestigation {
  overview: string;
  patterns: DataQualityPattern[];
  suggestedCorrections: DataQualityCorrection[];
  caveats: string[];
  sourceRefs: AiSourceRef[];
  confidenceLabel: AiConfidenceLabel;
  requiresApproval: true;
}

export const dataQualityPatternSchema = z.object({
  code: z.string().min(1).max(64),
  title: z.string().min(1).max(160),
  explanation: z.string().min(1).max(800),
  affectedCount: z.number().int().min(0).max(1_000_000).default(0),
  examples: z.array(z.string().min(1).max(300)).max(10).default([]),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
});

export const dataQualityCorrectionSchema = z.object({
  patternCode: z.string().min(1).max(64),
  field: z.string().min(1).max(64),
  suggestedCorrection: z.string().min(1).max(400),
  rationale: z.string().min(1).max(400),
  destructive: z.boolean().default(false),
});

export const dataQualityInvestigationSchema = z.object({
  overview: z.string().min(1).max(2000),
  patterns: z.array(dataQualityPatternSchema).max(12).default([]),
  suggestedCorrections: z.array(dataQualityCorrectionSchema).max(16).default([]),
  caveats: z.array(z.string().min(1).max(400)).max(8).default([]),
  sourceRefs: z.array(aiSourceRefSchema).max(20).default([]),
  confidenceLabel: z.enum(AI_CONFIDENCE_LABELS).default('INSUFFICIENT_EVIDENCE'),
});

export const investigateQualityRequestSchema = z.object({
  /** Exactly one of these must be supplied; the route enforces it. */
  batchId: z.string().max(64).optional(),
  snapshotId: z.string().max(64).optional(),
  exceptionId: z.string().max(64).optional(),
  focus: z.string().max(1000).optional(),
});
export type InvestigateQualityRequest = z.infer<typeof investigateQualityRequestSchema>;

// ---------------------------------------------------------------------------
// Feature 5 — Scenario Assistant
// ---------------------------------------------------------------------------

export interface ScenarioAdjustmentProposal {
  /** Existing scenario code to adjust, or a proposed new code. */
  code: string;
  name: string;
  kind: 'BASE' | 'UPSIDE' | 'DOWNSIDE';
  direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
  proposedWeight: string | null;
  proposedPdMultiplier: string | null;
  proposedLgdMultiplier: string | null;
  rationale: string;
}

export interface ScenarioProposal {
  name: string;
  narrative: string;
  proposedAdjustments: ScenarioAdjustmentProposal[];
  rationale: string;
  assumptions: string[];
  uncertainty: string;
  requiresApproval: true;
  /**
   * The scenario set and governance documents this draft was written against.
   * Supplied by the service from what it retrieved, never by the model, so a
   * reviewer can open each source rather than take the narrative on trust.
   */
  sourceRefs: AiSourceRef[];
}

export const scenarioAdjustmentProposalSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  kind: z.enum(['BASE', 'UPSIDE', 'DOWNSIDE']).default('BASE'),
  direction: z.enum(['INCREASE', 'DECREASE', 'UNCHANGED']).default('UNCHANGED'),
  proposedWeight: z.string().max(32).nullable().default(null),
  proposedPdMultiplier: z.string().max(32).nullable().default(null),
  proposedLgdMultiplier: z.string().max(32).nullable().default(null),
  rationale: z.string().min(1).max(600),
});

export const scenarioProposalSchema = z.object({
  name: z.string().min(3).max(120),
  narrative: z.string().min(1).max(2000),
  proposedAdjustments: z.array(scenarioAdjustmentProposalSchema).max(8).default([]),
  rationale: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(300)).max(10).default([]),
  uncertainty: z.string().min(1).max(800),
});

export const scenarioDraftRequestSchema = z.object({
  narrative: z.string().min(10, 'Describe the macroeconomic narrative in at least 10 characters').max(4000),
  /** Existing set the draft should be expressed against, when there is one. */
  scenarioSetId: z.string().max(64).optional(),
});
export type ScenarioDraftRequest = z.infer<typeof scenarioDraftRequestSchema>;

// ---------------------------------------------------------------------------
// Feature 6 — Document Intelligence
// ---------------------------------------------------------------------------

export const DOCUMENT_PROCESSING_STATUSES = [
  'QUEUED',
  'PARSING',
  'INDEXED',
  'EXTRACTED',
  'FAILED',
  'UNSUPPORTED',
] as const;
export type DocumentProcessingStatus = (typeof DOCUMENT_PROCESSING_STATUSES)[number];

export const DOCUMENT_CATEGORIES = ['POLICY', 'BORROWER_FINANCIAL', 'GUIDANCE', 'SUPPORTING', 'OTHER'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_SIGNAL_STATUSES = ['PROPOSED', 'ACCEPTED', 'REJECTED'] as const;
export type DocumentSignalStatus = (typeof DOCUMENT_SIGNAL_STATUSES)[number];

export interface ExtractedFact {
  label: string;
  value: string;
  /** ISO date when the fact is a date; otherwise empty. */
  asOf?: string;
  page?: number;
  /** True only when the value is written in the document, never derived. */
  verbatim: boolean;
}

export interface ProposedRiskSignal {
  code: string;
  title: string;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  page?: number;
  /** What in the document supports this. Required — an unsupported signal is noise. */
  supportingText: string;
}

export interface DocumentCitation {
  documentId: string;
  documentName: string;
  page?: number;
  chunkOrdinal?: number;
  quote: string;
}

export interface DocumentExtraction {
  documentType: string;
  summary: string;
  extractedFacts: ExtractedFact[];
  proposedRiskSignals: ProposedRiskSignal[];
  citations: DocumentCitation[];
  missingInformation: string[];
  warnings: string[];
  requiresApproval: true;
}

export const extractedFactSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(300),
  asOf: z.string().max(40).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  verbatim: z.boolean().default(false),
});

export const proposedRiskSignalSchema = z.object({
  code: z.string().min(1).max(64),
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(800),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  page: z.number().int().min(1).max(100_000).optional(),
  supportingText: z.string().min(1).max(600),
});

export const documentCitationSchema = z.object({
  documentId: z.string().max(64).default(''),
  documentName: z.string().max(200).default(''),
  page: z.number().int().min(1).max(100_000).optional(),
  chunkOrdinal: z.number().int().min(0).max(1_000_000).optional(),
  quote: z.string().min(1).max(600),
});

export const aiModelDocumentExtractionSchema = z.object({
  documentType: z.string().min(1).max(120),
  summary: z.string().min(1).max(3000),
  extractedFacts: z.array(extractedFactSchema).max(40).default([]),
  proposedRiskSignals: z.array(proposedRiskSignalSchema).max(20).default([]),
  citations: z.array(documentCitationSchema).max(20).default([]),
  missingInformation: z.array(z.string().min(1).max(300)).max(12).default([]),
  warnings: z.array(z.string().min(1).max(300)).max(12).default([]),
});

export interface DocumentChunkRecord {
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  tokenEstimate: number;
}

export interface DocumentSignalRecord {
  id: string;
  code: string;
  title: string;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  page: number | null;
  supportingText: string;
  status: DocumentSignalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface DocumentRecord {
  id: string;
  publicId: string;
  name: string;
  category: DocumentCategory;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  chunkCount: number;
  processingStatus: DocumentProcessingStatus;
  message: string;
  documentType: string | null;
  summary: string | null;
  uploadedBy: string;
  uploadedAt: string;
  updatedAt: string;
  /** Populated once extraction has run, either inline or on demand. */
  extraction: DocumentExtraction | null;
  signals: DocumentSignalRecord[];
  /** True when the document is part of the seeded governance knowledge base. */
  seeded: boolean;
}

export interface DocumentListResponse extends Paginated<DocumentRecord> {
  availability: AiAvailabilityRecord;
}

/**
 * The result of an upload.
 *
 * `duplicateOf` is the public id of an existing document with byte-identical
 * content, or null when this upload was new. Reported rather than silently
 * deduplicated: indexing the same file twice would let one policy quote two
 * citations that look independent, and the uploader is entitled to know that
 * what they see is a document someone already added.
 *
 * `availability` rides along because indexing and extraction have different
 * requirements — a document is chunked and citable with no model configured,
 * while extraction is not — so the upload screen has to say which half of the
 * feature the user just got.
 */
export interface DocumentUploadResponse {
  document: DocumentRecord;
  duplicateOf: string | null;
  availability: AiAvailabilityRecord;
}

export const documentListQuerySchema = listQuerySchema.extend({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  processingStatus: z.enum(DOCUMENT_PROCESSING_STATUSES).optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const signalDecisionRequestSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().min(3, 'A short note is required for the audit trail').max(1000),
});
export type SignalDecisionRequest = z.infer<typeof signalDecisionRequestSchema>;

export const documentExtractRequestSchema = z.object({
  /** Re-run extraction on an already-indexed document. */
  force: z.boolean().default(false),
});
export type DocumentExtractRequest = z.infer<typeof documentExtractRequestSchema>;

/**
 * The non-file fields of a multipart upload.
 *
 * Every value arrives as a string because that is what a multipart text part
 * is, so nothing here is coerced: a category that is not one of the listed
 * literals is a validation failure, not a value to be interpreted.
 */
export const documentUploadRequestSchema = z.object({
  /** Decides which retrieval searches the document answers. */
  category: z.enum(DOCUMENT_CATEGORIES).default('OTHER'),
  /** Display name. The uploaded filename is sanitized and used when omitted. */
  name: z.string().min(1).max(160).optional(),
});
export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

// ---------------------------------------------------------------------------
// Feature 7 — Executive Commentary
// ---------------------------------------------------------------------------

export type CommentaryClaimKind = 'FACT' | 'INFERENCE' | 'RECOMMENDATION';

export interface CommentaryMovement {
  label: string;
  detail: string;
  claimKind: CommentaryClaimKind;
  sourceRefs: AiSourceRef[];
}

export interface ExecutiveCommentary {
  headline: string;
  overview: string;
  keyMovements: CommentaryMovement[];
  riskConcentrations: CommentaryMovement[];
  dataLimitations: string[];
  actions: CommentaryMovement[];
  sourceRefs: AiSourceRef[];
  confidenceLabel: AiConfidenceLabel;
}

export const commentaryClaimKindSchema = z.enum(['FACT', 'INFERENCE', 'RECOMMENDATION']);

export const commentaryMovementSchema = z.object({
  label: z.string().min(1).max(160),
  detail: z.string().min(1).max(800),
  claimKind: commentaryClaimKindSchema.default('FACT'),
  sourceRefs: z.array(aiSourceRefSchema).max(8).default([]),
});

export const executiveCommentarySchema = z.object({
  headline: z.string().min(1).max(200),
  overview: z.string().min(1).max(2500),
  keyMovements: z.array(commentaryMovementSchema).max(10).default([]),
  riskConcentrations: z.array(commentaryMovementSchema).max(10).default([]),
  dataLimitations: z.array(z.string().min(1).max(400)).max(10).default([]),
  actions: z.array(commentaryMovementSchema).max(8).default([]),
  sourceRefs: z.array(aiSourceRefSchema).max(20).default([]),
  confidenceLabel: z.enum(AI_CONFIDENCE_LABELS).default('INSUFFICIENT_EVIDENCE'),
});

export const executiveCommentaryRequestSchema = z.object({
  runId: z.string().min(1).max(64),
  /** Optional audience hint, e.g. "ALCO", "board risk committee". */
  audience: z.string().max(120).optional(),
});
export type ExecutiveCommentaryRequest = z.infer<typeof executiveCommentaryRequestSchema>;

// ---------------------------------------------------------------------------
// Envelopes and the safe failure shape
// ---------------------------------------------------------------------------

/**
 * Every AI feature answers with this envelope so the client branches on
 * `status` once instead of per feature. `AI_UNAVAILABLE` and `SCHEMA_INVALID`
 * arrive with `result: null` and an honest `message`; the model is never
 * allowed to fill the gap with a plausible-looking fabrication.
 */
export interface AiResponse<T> {
  status: AiRequestStatus;
  feature: AiFeature;
  model: string;
  latencyMs: number;
  message: string;
  result: T | null;
  availability: AiAvailabilityRecord;
  requestId: string | null;
  /** Id of the persisted `AiRequest` row, so a user can quote it in a review. */
  aiRequestId: string | null;
  toolActivity: AiToolActivity[];
}

/** Codes the client branches on, mirroring the existing error-envelope style. */
export const AI_ERROR_CODES = [
  'AI_UNAVAILABLE',
  'AI_TIMEOUT',
  'AI_RATE_LIMITED',
  'AI_SCHEMA_INVALID',
  'AI_GROUNDING_REJECTED',
  'AI_INPUT_TOO_LARGE',
  'AI_EVIDENCE_MISSING',
  'DOCUMENT_UNSUPPORTED_TYPE',
  'DOCUMENT_PARSE_FAILED',
  'DOCUMENT_SIGNAL_ALREADY_DECIDED',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export type { Paginated };
