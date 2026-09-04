/**
 * Tests for the client-side AI guardrails.
 *
 * These are not component tests — the web workspace has no jsdom and no testing
 * library, and adding them to check label maps would be a poor trade. What is
 * tested here is the part of the AI surface that is a *promise to the reviewer*
 * rather than a layout decision: that a citation never links somewhere that does
 * not exist, that copied text cannot lose its sources, that an AI draft cannot
 * arrive pre-weighted, and that every enum the server can send has a human label.
 *
 * Keeping that logic in pure functions is what makes it testable at all, so a
 * failure here means a guardrail moved into JSX where nobody can assert it.
 */
import { describe, expect, it } from 'vitest';
import type {
  AiSourceRef,
  AiSourceRefKind,
  CommentaryClaimKind,
  CommentaryMovement,
  ExecutiveCommentary,
  ImportMappingSuggestion,
  PortfolioField,
  ScenarioAdjustmentProposal,
  ScenarioProposal,
} from '@eclens/shared';
import {
  AI_CONFIDENCE_LABELS,
  AI_MAPPING_CONFIDENCE_LEVELS,
  AI_REQUEST_STATUSES,
  AI_SOURCE_REF_KINDS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_PROCESSING_STATUSES,
  DOCUMENT_SIGNAL_STATUSES,
  PORTFOLIO_FIELDS,
} from '@eclens/shared';
import {
  CLAIM_TONE,
  CONFIDENCE_TONE,
  MAPPING_CONFIDENCE_TONE,
  PROCESSING_STATUS_TONE,
  SIGNAL_STATUS_TONE,
  STATUS_TONE,
  answerToClipboardText,
  categoryLabel,
  categoryShortLabel,
  claimKindLabel,
  commentaryToClipboardText,
  confidenceLabel,
  directionLabel,
  directionTone,
  mappingConfidenceLabel,
  mergeAiMappingSuggestions,
  processingStatusLabel,
  refKindLabel,
  refLabel,
  refRoute,
  scenarioProposalToDraftForm,
  signalStatusLabel,
  statusLabel,
} from './ai';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ref = (kind: AiSourceRefKind, id: string, extra?: Partial<AiSourceRef>): AiSourceRef => ({
  kind,
  id,
  ...extra,
});

const movement = (claimKind: CommentaryClaimKind, label: string): CommentaryMovement => ({
  label,
  detail: `${label} detail.`,
  claimKind,
  sourceRefs: [ref('RUN', 'RUN-1')],
});

const commentary = (): ExecutiveCommentary => ({
  headline: 'Allowance rose on stage 2 migration',
  overview: 'The portfolio allowance increased against the prior run.',
  keyMovements: [movement('FACT', 'Stage 2 grew by 40 exposures')],
  riskConcentrations: [movement('INFERENCE', 'Textile concentration looks riskier')],
  dataLimitations: ['Nine exposures carry a stale rating'],
  actions: [movement('RECOMMENDATION', 'Review the textile watchlist')],
  sourceRefs: [ref('RUN', 'RUN-SEED-001', { label: 'September run', locator: 'totals' })],
  confidenceLabel: 'MEDIUM',
});

const suggestion = (
  sourceColumn: string,
  targetField: PortfolioField | null,
  confidenceLevel: ImportMappingSuggestion['confidenceLevel'] = 'HIGH',
): ImportMappingSuggestion => ({
  sourceColumn,
  targetField,
  confidence: confidenceLevel === 'HIGH' ? 0.9 : 0.4,
  confidenceLevel,
  detectedUnit: 'CURRENCY_PKR',
  rationale: `Read as ${targetField ?? 'unmapped'} from the header.`,
  warnings: [],
});

const adjustment = (
  overrides: Partial<ScenarioAdjustmentProposal>,
): ScenarioAdjustmentProposal => ({
  code: 'BASE',
  name: 'Base case',
  kind: 'BASE',
  direction: 'UNCHANGED',
  proposedWeight: '0.6',
  proposedPdMultiplier: '1',
  proposedLgdMultiplier: '1',
  rationale: 'Unchanged from the set in force.',
  ...overrides,
});

const proposal = (overrides: Partial<ScenarioProposal>): ScenarioProposal => ({
  name: 'Downturn draft',
  narrative: 'A sharper downturn with a slower recovery.',
  proposedAdjustments: [adjustment({})],
  rationale: 'Macroeconomic indicators turned negative.',
  assumptions: ['Unemployment rises to 9%'],
  uncertainty: 'Wide — the recovery lag is not observable.',
  requiresApproval: true,
  sourceRefs: [ref('SCENARIO_SET', 'SSET-1')],
  ...overrides,
});

/** A mapping draft with every canonical field present, as the Imports page builds it. */
const draftOf = (
  overrides: Partial<Record<PortfolioField, string>> = {},
): Record<PortfolioField, string> =>
  Object.fromEntries(PORTFOLIO_FIELDS.map((field) => [field, overrides[field] ?? ''])) as Record<
    PortfolioField,
    string
  >;

// ---------------------------------------------------------------------------
// Citations must never link somewhere that does not exist
// ---------------------------------------------------------------------------

describe('refRoute', () => {
  it('returns no route for governance guidance, which has no page in this app', () => {
    // `SourceRefChip` renders a plain <span> when this is null. A chip that
    // linked to a route rendering "not found" would be worse than one that
    // plainly does not link.
    expect(refRoute(ref('GOVERNANCE_GUIDANCE', 'IFRS9-2024'))).toBeNull();
  });

  it('routes a document citation to the deep link the documents page honours', () => {
    expect(refRoute(ref('DOCUMENT', 'DOC-7'))).toBe('/documents?doc=DOC-7');
  });

  it('routes an exposure citation to the portfolio drill-down, not a nonexistent /exposures path', () => {
    expect(refRoute(ref('EXPOSURE', 'EXP-1'))).toBe('/portfolio/EXP-1');
    expect(refRoute(ref('RUN', 'RUN-1'))).toBe('/ecl-runs/RUN-1');
  });

  it('gives every other kind a real destination', () => {
    const linked = AI_SOURCE_REF_KINDS.filter((kind) => kind !== 'GOVERNANCE_GUIDANCE');
    for (const kind of linked) {
      const route = refRoute(ref(kind, 'ID-1'));
      expect(route, `${kind} should be openable in the app`).toBeTruthy();
      expect(route?.startsWith('/')).toBe(true);
    }
  });

  it('URL-encodes ids so a slash or space cannot break out of the path', () => {
    expect(refRoute(ref('RUN', 'RUN 1/2'))).toBe('/ecl-runs/RUN%201%2F2');
    expect(refRoute(ref('DOCUMENT', 'a&b=c'))).toBe('/documents?doc=a%26b%3Dc');
  });

  it('falls back to the id when the server sent no label', () => {
    expect(refLabel(ref('RUN', 'RUN-9'))).toBe('RUN-9');
    expect(refLabel(ref('RUN', 'RUN-9', { label: 'September run' }))).toBe('September run');
  });
});

// ---------------------------------------------------------------------------
// Copied text must not lose its provenance
// ---------------------------------------------------------------------------

describe('answerToClipboardText', () => {
  it('carries every source id and every caveat out with the prose', () => {
    // An answer pasted into an email that has lost its citations is the failure
    // the grounding guard exists to prevent, reappearing one step downstream.
    const text = answerToClipboardText({
      answer: 'The allowance is PKR 1.2m.',
      sourceRefs: [ref('RUN', 'RUN-1'), ref('EXPOSURE', 'EXP-2', { locator: 'period 4' })],
      caveats: ['Rounded to 2 decimals.', 'One scenario weight was overridden.'],
    });

    expect(text).toContain('The allowance is PKR 1.2m.');
    for (const id of ['RUN-1', 'EXP-2']) expect(text).toContain(id);
    expect(text).toContain('period 4');
    expect(text).toContain('Rounded to 2 decimals.');
    expect(text).toContain('One scenario weight was overridden.');
    expect(text).toContain('Sources:');
    expect(text).toContain('Caveats:');
  });

  it('omits the source and caveat blocks when there is nothing to put in them', () => {
    const text = answerToClipboardText({
      answer: 'Nothing stored yet.',
      sourceRefs: [],
      caveats: [],
    });
    expect(text).toBe('Nothing stored yet.');
  });

  it('names the kind of each source so a reader knows what the id points at', () => {
    const text = answerToClipboardText({
      answer: 'x',
      sourceRefs: [ref('IMPORT_BATCH', 'BAT-3', { label: 'August file' })],
      caveats: [],
    });
    expect(text).toContain('Import August file [BAT-3]');
  });
});

describe('commentaryToClipboardText', () => {
  it('writes the claim kind into the text, because a pasted commentary has no badges', () => {
    const text = commentaryToClipboardText(commentary());
    expect(text).toContain('[FACT] Stage 2 grew by 40 exposures');
    expect(text).toContain('[INFERENCE] Textile concentration looks riskier');
    expect(text).toContain('[RECOMMENDATION] Review the textile watchlist');
  });

  it('keeps the headline, overview, limitations and sources', () => {
    const text = commentaryToClipboardText(commentary());
    expect(text).toContain('Allowance rose on stage 2 migration');
    expect(text).toContain('The portfolio allowance increased against the prior run.');
    expect(text).toContain('Nine exposures carry a stale rating');
    expect(text).toContain('RUN-SEED-001');
    expect(text).toContain('Key movements:');
    expect(text).toContain('Risk concentrations:');
    expect(text).toContain('Recommended actions:');
  });

  it('ends by saying which parts are the model’s, so the note survives the paste', () => {
    const text = commentaryToClipboardText(commentary());
    const closing = text.split('\n\n').pop() ?? '';
    expect(closing).toContain('Drafted by an AI assistant');
    expect(closing).toContain('AI can make mistakes');
    expect(text.indexOf(closing)).toBeGreaterThan(text.indexOf('RUN-SEED-001'));
  });

  it('survives an empty commentary without inventing sections', () => {
    const text = commentaryToClipboardText({
      ...commentary(),
      keyMovements: [],
      riskConcentrations: [],
      actions: [],
      dataLimitations: [],
    });
    expect(text).not.toContain('Key movements:');
    expect(text).not.toContain('Data limitations:');
    expect(text).toContain('Drafted by an AI assistant');
  });
});

// ---------------------------------------------------------------------------
// Every value the server can send has a human label and a tone
// ---------------------------------------------------------------------------

describe('labels cover the whole wire contract', () => {
  it('labels and tones every request status, disclosing a schema repair rather than hiding it', () => {
    for (const status of AI_REQUEST_STATUSES) {
      expect(statusLabel(status), status).toBeTruthy();
      expect(STATUS_TONE[status], status).toBeTruthy();
    }
    expect(statusLabel('SCHEMA_REPAIRED')).toContain('retry');
    expect(statusLabel('UNAVAILABLE')).toContain('unavailable');
  });

  it('labels and tones every confidence label', () => {
    for (const label of AI_CONFIDENCE_LABELS) {
      expect(confidenceLabel(label), label).toBeTruthy();
      expect(CONFIDENCE_TONE[label], label).toBeTruthy();
    }
  });

  it('keeps UNSURE distinct from LOW', () => {
    // A suggestion the model is unsure about and one it is confident about but
    // wrong look identical to the person accepting them; only the first says so.
    for (const level of AI_MAPPING_CONFIDENCE_LEVELS) {
      expect(mappingConfidenceLabel(level), level).toBeTruthy();
      expect(MAPPING_CONFIDENCE_TONE[level], level).toBeTruthy();
    }
    expect(mappingConfidenceLabel('UNSURE')).not.toBe(mappingConfidenceLabel('LOW'));
  });

  it('labels every claim kind as something a board reader can act on', () => {
    const kinds: CommentaryClaimKind[] = ['FACT', 'INFERENCE', 'RECOMMENDATION'];
    for (const kind of kinds) {
      expect(claimKindLabel(kind), kind).toBeTruthy();
      expect(CLAIM_TONE[kind], kind).toBeTruthy();
    }
    expect(claimKindLabel('FACT')).toContain('stored records');
    expect(claimKindLabel('INFERENCE')).toContain('model');
    expect(claimKindLabel('RECOMMENDATION')).toContain('model');
  });

  it('keeps INDEXED and EXTRACTED as different words', () => {
    for (const status of DOCUMENT_PROCESSING_STATUSES) {
      expect(processingStatusLabel(status), status).toBeTruthy();
      expect(PROCESSING_STATUS_TONE[status], status).toBeTruthy();
    }
    // Indexed is deterministic PostgreSQL work that succeeds with no API key;
    // extracted needed a model. Collapsing them hides which half a deployment has.
    expect(processingStatusLabel('INDEXED')).not.toBe(processingStatusLabel('EXTRACTED'));
    expect(processingStatusLabel('INDEXED')).toContain('citable');
  });

  it('labels every signal status and tells a reviewer a proposal is waiting on them', () => {
    for (const status of DOCUMENT_SIGNAL_STATUSES) {
      expect(signalStatusLabel(status), status).toBeTruthy();
      expect(SIGNAL_STATUS_TONE[status], status).toBeTruthy();
    }
    expect(signalStatusLabel('PROPOSED')).toContain('awaiting');
  });

  it('labels every document category, long and short', () => {
    for (const category of DOCUMENT_CATEGORIES) {
      expect(categoryLabel(category), category).toBeTruthy();
      expect(categoryShortLabel(category), category).toBeTruthy();
    }
  });

  it('labels every source-ref kind', () => {
    for (const kind of AI_SOURCE_REF_KINDS) expect(refKindLabel(kind), kind).toBeTruthy();
  });

  it('labels and tones every proposed adjustment direction', () => {
    const directions: ScenarioAdjustmentProposal['direction'][] = [
      'INCREASE',
      'DECREASE',
      'UNCHANGED',
    ];
    for (const direction of directions) {
      expect(directionLabel(direction), direction).toBeTruthy();
      expect(directionTone(direction), direction).toBeTruthy();
    }
    // An increase in expected loss is bad news and must not read as positive.
    expect(directionTone('INCREASE')).toBe('danger');
    expect(directionTone('DECREASE')).toBe('positive');
  });
});

// ---------------------------------------------------------------------------
// An AI scenario draft cannot arrive pre-weighted
// ---------------------------------------------------------------------------

describe('scenarioProposalToDraftForm', () => {
  it('turns a weight the model declined to propose into zero, not into a plausible share', () => {
    // Zero leaves the active-weight total short of 1, so the form's own
    // validation blocks the submit and a person supplies the number.
    const form = scenarioProposalToDraftForm(
      proposal({ proposedAdjustments: [adjustment({ proposedWeight: null })] }),
    );
    expect(form.scenarios[0]?.weight).toBe('0');
  });

  it('defaults absent multipliers to neutral rather than to a stressed value', () => {
    const form = scenarioProposalToDraftForm(
      proposal({
        proposedAdjustments: [
          adjustment({ proposedPdMultiplier: null, proposedLgdMultiplier: null }),
        ],
      }),
    );
    expect(form.scenarios[0]?.pdMultiplier).toBe('1');
    expect(form.scenarios[0]?.lgdMultiplier).toBe('1');
  });

  it('carries every proposed adjustment across, all of them active', () => {
    const form = scenarioProposalToDraftForm(
      proposal({
        proposedAdjustments: [
          adjustment({ code: 'BASE', proposedWeight: '0.5' }),
          adjustment({
            code: 'DOWN',
            name: 'Downturn',
            direction: 'INCREASE',
            proposedWeight: '0.5',
          }),
        ],
      }),
    );
    expect(form.scenarios.map((scenario) => scenario.code)).toEqual(['BASE', 'DOWN']);
    expect(form.scenarios.every((scenario) => scenario.isActive)).toBe(true);
  });

  it('trims the name and narrative to what the create request will accept', () => {
    // Capped here rather than left for the form to reject, so the reviewer is
    // not handed a draft they cannot submit.
    const form = scenarioProposalToDraftForm(
      proposal({ name: 'n'.repeat(200), narrative: 'x'.repeat(1500) }),
    );
    expect(form.name).toHaveLength(120);
    expect(form.description).toHaveLength(1000);
    expect(form.name.endsWith('…')).toBe(true);
  });

  it('leaves a name that already fits untouched', () => {
    const form = scenarioProposalToDraftForm(
      proposal({ name: 'Downturn draft', narrative: 'Short.' }),
    );
    expect(form.name).toBe('Downturn draft');
    expect(form.description).toBe('Short.');
  });
});

// ---------------------------------------------------------------------------
// Staging AI suggestions must be visible and must not write anything
// ---------------------------------------------------------------------------

describe('mergeAiMappingSuggestions', () => {
  it('applies a suggestion and reports the change it made', () => {
    const current = draftOf({ grossCarryingAmount: 'Amount' });
    const { draft, changes } = mergeAiMappingSuggestions(
      [suggestion("Outstanding Principal (PKR '000)", 'grossCarryingAmount')],
      current,
    );
    expect(draft.grossCarryingAmount).toBe("Outstanding Principal (PKR '000)");
    expect(changes).toEqual([
      { field: 'grossCarryingAmount', from: 'Amount', to: "Outstanding Principal (PKR '000)" },
    ]);
  });

  it('leaves a column the model could not place alone', () => {
    const current = draftOf({ grossCarryingAmount: 'Amount' });
    const { draft, changes } = mergeAiMappingSuggestions(
      [suggestion('Free-form notes', null)],
      current,
    );
    expect(draft).toEqual(current);
    expect(changes).toEqual([]);
  });

  it('reports no change when the form already agrees with the model', () => {
    const current = draftOf({ lgd: 'Loss Rate' });
    const { draft, changes } = mergeAiMappingSuggestions([suggestion('Loss Rate', 'lgd')], current);
    expect(draft).toEqual(current);
    expect(changes).toEqual([]);
  });

  it('ignores a field that is not in the draft it was given', () => {
    const { draft, changes } = mergeAiMappingSuggestions<'grossCarryingAmount'>(
      [suggestion('Loss Rate', 'lgd')],
      { grossCarryingAmount: '' },
    );
    expect(draft).toEqual({ grossCarryingAmount: '' });
    expect(changes).toEqual([]);
  });

  it('does not mutate the draft the Imports page owns', () => {
    // The form is React state. Mutating it in place would apply the AI's
    // suggestions without a re-render, so the reviewer would see an unchanged
    // form holding changed values.
    const current = draftOf({ lgd: 'Loss Rate' });
    const snapshot = { ...current };
    mergeAiMappingSuggestions([suggestion('Recovery Severity', 'lgd')], current);
    expect(current).toEqual(snapshot);
  });

  it('applies several suggestions and reports each one separately', () => {
    const current = draftOf({ exposureId: '', lgd: 'Loss Rate' });
    const { draft, changes } = mergeAiMappingSuggestions(
      [
        suggestion('Loan Number', 'exposureId'),
        suggestion('Recovery Severity', 'lgd'),
        suggestion('Notes', null),
      ],
      current,
    );
    expect(draft.exposureId).toBe('Loan Number');
    expect(draft.lgd).toBe('Recovery Severity');
    expect(changes).toHaveLength(2);
    // `''` reads as "unmapped" in the diff the reviewer is shown.
    expect(changes[0]).toEqual({ field: 'exposureId', from: '', to: 'Loan Number' });
  });
});
