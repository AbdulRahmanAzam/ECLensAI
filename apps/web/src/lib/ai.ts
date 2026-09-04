/**
 * Presentation logic for the AI surface, kept out of the components.
 *
 * Everything here is a pure function over the wire contract, which is why it lives
 * in `lib` rather than beside the JSX: these are the decisions a reviewer needs to
 * be able to check without a browser — where a citation links, what a confidence
 * label is called, and what a copied answer carries with it. The components render
 * the results; the tests below the line assert them.
 */
import type {
  AiConfidenceLabel,
  AiMappingConfidence,
  AiRequestStatus,
  AiSourceRef,
  AiSourceRefKind,
  CommentaryClaimKind,
  CommentaryMovement,
  DataQualityPattern,
  DocumentCategory,
  DocumentProcessingStatus,
  DocumentSignalStatus,
  ExecutiveCommentary,
  ImportMappingSuggestion,
  ScenarioAdjustmentProposal,
  ScenarioProposal,
} from '@eclens/shared';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Where a citation of this kind can be opened in the app.
 *
 * Deliberately a partial map. `GOVERNANCE_GUIDANCE` cites external public guidance
 * that has no page here, and a chip that linked to a route rendering "not found"
 * would be worse than one that plainly does not link. Ids are public identifiers,
 * which is what the routes take.
 */
const REF_ROUTES: Partial<Record<AiSourceRefKind, (id: string) => string>> = {
  RUN: (id) => `/ecl-runs/${encodeURIComponent(id)}`,
  EXPOSURE: (id) => `/portfolio/${encodeURIComponent(id)}`,
  DOCUMENT: (id) => `/documents?doc=${encodeURIComponent(id)}`,
  SNAPSHOT: () => '/portfolio',
  IMPORT_BATCH: () => '/imports',
  SCENARIO_SET: () => '/scenarios',
  MODEL_CONFIGURATION: () => '/model-governance',
  EXCEPTION: () => '/exceptions',
  PORTFOLIO_SUMMARY: () => '/dashboard',
};

export function refRoute(ref: AiSourceRef): string | null {
  return REF_ROUTES[ref.kind]?.(ref.id) ?? null;
}

const REF_KIND_LABEL: Record<AiSourceRefKind, string> = {
  RUN: 'Run',
  EXPOSURE: 'Exposure',
  SNAPSHOT: 'Snapshot',
  IMPORT_BATCH: 'Import',
  SCENARIO_SET: 'Scenario set',
  MODEL_CONFIGURATION: 'Model config',
  EXCEPTION: 'Exception',
  DOCUMENT: 'Document',
  PORTFOLIO_SUMMARY: 'Portfolio',
  GOVERNANCE_GUIDANCE: 'Guidance',
};

export function refLabel(ref: AiSourceRef): string {
  return ref.label ?? ref.id;
}

export function refKindLabel(kind: AiSourceRefKind): string {
  return REF_KIND_LABEL[kind];
}

export const CONFIDENCE_TONE: Record<AiConfidenceLabel, BadgeTone> = {
  HIGH: 'positive',
  MEDIUM: 'info',
  LOW: 'warning',
  INSUFFICIENT_EVIDENCE: 'neutral',
};

const CONFIDENCE_LABEL: Record<AiConfidenceLabel, string> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export function confidenceLabel(label: AiConfidenceLabel): string {
  return CONFIDENCE_LABEL[label];
}

export const STATUS_TONE: Record<AiRequestStatus, BadgeTone> = {
  SUCCEEDED: 'positive',
  SCHEMA_REPAIRED: 'warning',
  SCHEMA_INVALID: 'danger',
  FAILED: 'danger',
  UNAVAILABLE: 'neutral',
};

/**
 * How a request status reads to an analyst.
 *
 * `SCHEMA_REPAIRED` is disclosed rather than hidden: the first response did not
 * match the required structure and a second attempt produced this one. A user is
 * entitled to know an answer took two tries.
 */
const STATUS_LABEL: Record<AiRequestStatus, string> = {
  SUCCEEDED: 'grounded',
  SCHEMA_REPAIRED: 'corrected on retry',
  SCHEMA_INVALID: 'rejected: invalid structure',
  FAILED: 'no answer',
  UNAVAILABLE: 'AI unavailable',
};

export function statusLabel(status: AiRequestStatus): string {
  return STATUS_LABEL[status];
}

export const MAPPING_CONFIDENCE_TONE: Record<AiMappingConfidence, BadgeTone> = {
  HIGH: 'positive',
  MEDIUM: 'info',
  LOW: 'warning',
  UNSURE: 'danger',
};

/**
 * `UNSURE` is kept as its own word rather than folded into "low confidence".
 *
 * A suggestion the model is unsure about and one it is confident about but wrong
 * look identical to the person accepting them, and the only defence is that the
 * first one says so. Merging the two labels would remove it.
 */
const MAPPING_CONFIDENCE_LABEL: Record<AiMappingConfidence, string> = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNSURE: 'unsure',
};

export function mappingConfidenceLabel(level: AiMappingConfidence): string {
  return MAPPING_CONFIDENCE_LABEL[level];
}

export const SEVERITY_TONE: Record<DataQualityPattern['severity'], BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
};

export const CLAIM_TONE: Record<CommentaryClaimKind, BadgeTone> = {
  FACT: 'info',
  INFERENCE: 'warning',
  RECOMMENDATION: 'neutral',
};

/**
 * The distinction the commentary contract exists to make visible.
 *
 * A board pack that reads uniformly is one where nobody can tell a stored figure
 * from a model's guess about it, so every movement, concentration and action is
 * labelled with the kind of claim it is and the labels are spelled out rather
 * than left as the raw enum.
 */
const CLAIM_LABEL: Record<CommentaryClaimKind, string> = {
  FACT: 'fact from stored records',
  INFERENCE: 'inference by the model',
  RECOMMENDATION: 'recommendation by the model',
};

export function claimKindLabel(kind: CommentaryClaimKind): string {
  return CLAIM_LABEL[kind];
}

const DIRECTION_LABEL: Record<ScenarioAdjustmentProposal['direction'], string> = {
  INCREASE: 'increase',
  DECREASE: 'decrease',
  UNCHANGED: 'unchanged',
};

const DIRECTION_TONE: Record<ScenarioAdjustmentProposal['direction'], BadgeTone> = {
  INCREASE: 'danger',
  DECREASE: 'positive',
  UNCHANGED: 'neutral',
};

export function directionLabel(direction: ScenarioAdjustmentProposal['direction']): string {
  return DIRECTION_LABEL[direction];
}

export function directionTone(direction: ScenarioAdjustmentProposal['direction']): BadgeTone {
  return DIRECTION_TONE[direction];
}

export const PROCESSING_STATUS_TONE: Record<DocumentProcessingStatus, BadgeTone> = {
  QUEUED: 'neutral',
  PARSING: 'info',
  INDEXED: 'positive',
  EXTRACTED: 'positive',
  FAILED: 'danger',
  UNSUPPORTED: 'warning',
};

/**
 * `INDEXED` and `EXTRACTED` are deliberately distinct words.
 *
 * A document that is indexed is chunked and citable — retrieval works on it with
 * no model configured. A document that is extracted also has facts and proposed
 * signals, which needed a model. Collapsing the two labels would hide which half
 * of the feature a deployment actually has, and that is exactly what an
 * availability notice is for.
 */
const PROCESSING_STATUS_LABEL: Record<DocumentProcessingStatus, string> = {
  QUEUED: 'queued',
  PARSING: 'parsing',
  INDEXED: 'indexed · citable',
  EXTRACTED: 'extracted',
  FAILED: 'failed',
  UNSUPPORTED: 'unsupported type',
};

export function processingStatusLabel(status: DocumentProcessingStatus): string {
  return PROCESSING_STATUS_LABEL[status];
}

export const SIGNAL_STATUS_TONE: Record<DocumentSignalStatus, BadgeTone> = {
  PROPOSED: 'warning',
  ACCEPTED: 'positive',
  REJECTED: 'neutral',
};

const SIGNAL_STATUS_LABEL: Record<DocumentSignalStatus, string> = {
  PROPOSED: 'proposed · awaiting your decision',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
};

export function signalStatusLabel(status: DocumentSignalStatus): string {
  return SIGNAL_STATUS_LABEL[status];
}

/**
 * What a category decides: which retrieval searches the document answers.
 *
 * Spelled out in the upload form rather than left as the raw enum, because
 * choosing wrongly does not fail loudly — the document simply never surfaces for
 * the questions it was uploaded to answer.
 */
const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  POLICY: 'Credit / ECL policy — answers “what does our policy say”',
  BORROWER_FINANCIAL: 'Borrower financials — answers questions about one obligor',
  GUIDANCE: 'External guidance — IFRS 9 interpretation and supervisory notes',
  SUPPORTING: 'Supporting evidence — memos, committee minutes, model documentation',
  OTHER: 'Other — indexed, but not tied to a question type',
};

const CATEGORY_SHORT_LABEL: Record<DocumentCategory, string> = {
  POLICY: 'Policy',
  BORROWER_FINANCIAL: 'Borrower financials',
  GUIDANCE: 'Guidance',
  SUPPORTING: 'Supporting',
  OTHER: 'Other',
};

export function categoryLabel(category: DocumentCategory): string {
  return CATEGORY_LABEL[category];
}

export function categoryShortLabel(category: DocumentCategory): string {
  return CATEGORY_SHORT_LABEL[category];
}

/**
 * The source list, composed once so every copy action carries the same thing.
 */
function sourcesBlock(refs: AiSourceRef[]): string | null {
  if (refs.length === 0) return null;
  return [
    'Sources:',
    ...refs.map(
      (ref) =>
        `- ${refKindLabel(ref.kind)} ${refLabel(ref)}${ref.locator ? ` (${ref.locator})` : ''} [${ref.id}]`,
    ),
  ].join('\n');
}

/**
 * What the copy action puts on the clipboard.
 *
 * The citations and caveats travel with the prose, always. An answer pasted into
 * an email or a review note that has lost its sources is the failure mode the
 * grounding guard exists to prevent, reappearing one step downstream — so the
 * clipboard text is built to make that impossible rather than to be pretty.
 */
export function answerToClipboardText(answer: {
  answer: string;
  sourceRefs: AiSourceRef[];
  caveats: string[];
}): string {
  const sections = [answer.answer];
  const sources = sourcesBlock(answer.sourceRefs);
  if (sources) sections.push(sources);
  if (answer.caveats.length > 0) {
    sections.push(['Caveats:', ...answer.caveats.map((caveat) => `- ${caveat}`)].join('\n'));
  }
  return sections.join('\n\n');
}

function movementLines(movements: CommentaryMovement[]): string[] {
  // The claim kind is written into the text rather than left to the badge, because
  // a pasted commentary has no badges and would otherwise read as uniformly
  // authoritative.
  return movements.map(
    (movement) => `- [${movement.claimKind}] ${movement.label} — ${movement.detail}`,
  );
}

/**
 * An executive commentary as plain text for a board pack.
 *
 * Same rule as `answerToClipboardText`, plus the claim kinds spelled out and a
 * closing note stating which parts are the model's. The commentary is the one AI
 * output designed to leave this application, so the text has to carry its own
 * provenance once it has.
 */
export function commentaryToClipboardText(commentary: ExecutiveCommentary): string {
  const sections = [commentary.headline, commentary.overview];

  const groups: Array<[string, CommentaryMovement[]]> = [
    ['Key movements', commentary.keyMovements],
    ['Risk concentrations', commentary.riskConcentrations],
    ['Recommended actions', commentary.actions],
  ];
  for (const [heading, movements] of groups) {
    if (movements.length > 0)
      sections.push([`${heading}:`, ...movementLines(movements)].join('\n'));
  }

  if (commentary.dataLimitations.length > 0) {
    sections.push(
      ['Data limitations:', ...commentary.dataLimitations.map((item) => `- ${item}`)].join('\n'),
    );
  }

  const sources = sourcesBlock(commentary.sourceRefs);
  if (sources) sections.push(sources);

  sections.push(
    'Drafted by an AI assistant from this organisation’s stored records. Every figure is copied from the sources cited above; the framing, inferences and recommendations are the model’s and are not an approval of anything. AI can make mistakes — verify before circulating.',
  );

  return sections.join('\n\n');
}

/** The shape the Scenarios page's own create-version modal is driven by. */
export interface ScenarioDraftFormScenario {
  code: string;
  name: string;
  weight: string;
  pdMultiplier: string;
  lgdMultiplier: string;
  isActive: boolean;
  description: string;
}

export interface ScenarioDraftForm {
  name: string;
  description: string;
  scenarios: ScenarioDraftFormScenario[];
}

/** Trim to what the create request will accept rather than let the form reject it later. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turns an AI draft into form state, and nothing more.
 *
 * The proposal is *carried into the existing modal*, not submitted: there is no
 * create call anywhere near this function, which is the whole of the guarantee
 * that an AI-proposed scenario needs a human to publish it.
 *
 * A null weight becomes `'0'` rather than a plausible share. That leaves the
 * active-weight total short of 1 whenever the model declined to propose a
 * weighting, so the form's own validation blocks the submit and the reviewer
 * supplies the number — the alternative is a default deciding the weighting of an
 * ECL run while looking as though the model had proposed it.
 */
export function scenarioProposalToDraftForm(proposal: ScenarioProposal): ScenarioDraftForm {
  return {
    name: cap(proposal.name, 120),
    description: cap(proposal.narrative, 1000),
    scenarios: proposal.proposedAdjustments.map((adjustment) => ({
      code: adjustment.code,
      name: adjustment.name,
      weight: adjustment.proposedWeight ?? '0',
      pdMultiplier: adjustment.proposedPdMultiplier ?? '1',
      lgdMultiplier: adjustment.proposedLgdMultiplier ?? '1',
      isActive: true,
      description: cap(adjustment.rationale, 1000),
    })),
  };
}

export interface MappingChange<TField extends string> {
  field: TField;
  from: string;
  to: string;
}

/**
 * Folds AI suggestions into the mapping draft the Imports page already owns.
 *
 * Returns the changes separately because the reviewer is entitled to see them
 * before they land: a form that silently rearranges eleven selects when a button
 * is clicked is indistinguishable from one that has broken, and the diff is the
 * only thing that makes "use as a starting point" mean what it says.
 *
 * Uniqueness per target field is already guaranteed by the server, which drops
 * the less confident of two columns claiming one field and says so in the
 * caveats — so this merge does not have to arbitrate, only apply.
 */
export function mergeAiMappingSuggestions<TField extends string>(
  suggestions: ImportMappingSuggestion[],
  current: Record<TField, string>,
): { draft: Record<TField, string>; changes: Array<MappingChange<TField>> } {
  const draft = { ...current };
  const changes: Array<MappingChange<TField>> = [];

  for (const suggestion of suggestions) {
    if (suggestion.targetField === null) continue;
    const field = suggestion.targetField as TField;
    if (!(field in draft)) continue;
    if (draft[field] === suggestion.sourceColumn) continue;
    changes.push({ field, from: draft[field], to: suggestion.sourceColumn });
    draft[field] = suggestion.sourceColumn;
  }

  return { draft, changes };
}
