/**
 * Build Scenario Draft.
 *
 * The draft stops at the reviewer. `onUseDraft` carries the proposal into the
 * Scenarios page's own create-version modal, prefilled and editable; this panel
 * never calls `api.scenarios.create`, and the server exposes no tool that could
 * do it for us. `requiresApproval` is not decoration — it is the contract field
 * that says so, and it is rendered because a proposal that quietly became a
 * published scenario set would be the one AI-driven mutation the product cannot
 * recover from.
 */
import { useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { ScenarioDraftRequest, ScenarioProposal } from '@eclens/shared';
import { decimalStringToNumber } from '@eclens/shared';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useAiFeature } from '@/hooks/useAi';
import {
  directionLabel,
  directionTone,
  scenarioProposalToDraftForm,
  type ScenarioDraftForm,
} from '@/lib/ai';
import { AiLineList, AiProse, AiSourceRefs } from './AiChrome';
import { AiResponseFrame } from './AiResponseFrame';

const MIN_NARRATIVE = 10;
const MAX_NARRATIVE = 4000;

export interface ScenarioDraftPanelProps {
  /** The set the draft should be expressed against, when one is selected. */
  scenarioSetId?: string;
  /** Hands the draft to the page's existing create-version modal. */
  onUseDraft: (draft: ScenarioDraftForm) => void;
}

export function ScenarioDraftPanel({ scenarioSetId, onUseDraft }: ScenarioDraftPanelProps) {
  const [narrative, setNarrative] = useState('');
  const draft = useAiFeature<ScenarioDraftRequest, ScenarioProposal>(api.ai.draftScenario);

  const ask = () => {
    const text = narrative.trim();
    if (text.length < MIN_NARRATIVE) return;
    draft.run(scenarioSetId ? { narrative: text, scenarioSetId } : { narrative: text });
  };

  const askable = narrative.trim().length >= MIN_NARRATIVE;
  const proposal = draft.response?.result;
  // A weight the model left null arrives as '0', so the total below is the honest
  // one the reviewer will meet in the form — not a number rounded up to look ready.
  const proposedWeightSum = (proposal?.proposedAdjustments ?? []).reduce(
    (total, adjustment) =>
      total + (adjustment.proposedWeight ? decimalStringToNumber(adjustment.proposedWeight) : 0),
    0,
  );

  return (
    <AiResponseFrame<ScenarioProposal>
      response={draft.response}
      failure={draft.failure}
      isPending={draft.isPending}
      title="Build a scenario draft"
      description="Describe the macroeconomic narrative; a draft weighting comes back for you to review, edit and publish yourself."
      actions={
        proposal ? (
          <>
            <Badge tone="warning">approval required</Badge>
            <Button
              size="sm"
              icon={<ArrowRight className="h-4 w-4" />}
              onClick={() => onUseDraft(scenarioProposalToDraftForm(proposal))}
            >
              Use in new version
            </Button>
          </>
        ) : null
      }
      onRetry={ask}
      idle={
        <div className="space-y-2">
          <label className="block">
            <span className="text-2xs font-medium uppercase tracking-wider text-slate-400">
              Macroeconomic narrative
            </span>
            <textarea
              value={narrative}
              onChange={(event) => setNarrative(event.target.value)}
              rows={4}
              maxLength={MAX_NARRATIVE}
              placeholder="e.g. Policy rate held at 15% through the year, inflation easing to 9%, GDP growth of 1.5%, with the textile export segment under pressure from weaker EU demand."
              className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-2.5 py-2 text-xs leading-relaxed text-slate-700 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-slate-500">
              {askable
                ? 'A draft is written against the active scenario set and this organisation’s governance documents.'
                : `Describe the narrative in at least ${MIN_NARRATIVE} characters.`}
            </p>
            <Button
              size="sm"
              icon={<Sparkles className="h-4 w-4" />}
              disabled={!askable}
              onClick={ask}
            >
              Build draft
            </Button>
          </div>
        </div>
      }
    >
      {(result) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-navy-950">{result.name}</p>
            <span className="tabular-nums text-2xs text-slate-500">
              proposed weights total {(proposedWeightSum * 100).toFixed(1)}%
            </span>
            {Math.abs(proposedWeightSum - 1) < 1e-9 ? (
              <Badge tone="positive">totals 100%</Badge>
            ) : (
              <Badge tone="danger">you must complete the weighting</Badge>
            )}
          </div>

          <AiProse title="Narrative" body={result.narrative} />

          {result.proposedAdjustments.length > 0 ? (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-slate-400">
                Proposed adjustments
              </p>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="border-b border-line bg-surface-2 text-2xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-2.5 py-2 font-medium">Scenario</th>
                      <th className="px-2.5 py-2 font-medium">Direction</th>
                      <th className="px-2.5 py-2 font-medium">Weight</th>
                      <th className="px-2.5 py-2 font-medium">PD ×</th>
                      <th className="px-2.5 py-2 font-medium">LGD ×</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {result.proposedAdjustments.map((adjustment) => (
                      <tr key={adjustment.code}>
                        <td className="px-2.5 py-2">
                          <span className="block font-medium text-slate-800">
                            {adjustment.name}
                          </span>
                          <code className="block font-mono text-2xs text-slate-400">
                            {adjustment.code} · {adjustment.kind.toLowerCase()}
                          </code>
                          <span className="mt-0.5 block text-2xs leading-relaxed text-slate-500">
                            {adjustment.rationale}
                          </span>
                        </td>
                        <td className="px-2.5 py-2">
                          <Badge tone={directionTone(adjustment.direction)}>
                            {directionLabel(adjustment.direction)}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-2 tabular-nums text-slate-700">
                          {adjustment.proposedWeight ?? (
                            <span className="text-red-600">not proposed</span>
                          )}
                        </td>
                        <td className="px-2.5 py-2 tabular-nums text-slate-700">
                          {adjustment.proposedPdMultiplier ?? '—'}
                        </td>
                        <td className="px-2.5 py-2 tabular-nums text-slate-700">
                          {adjustment.proposedLgdMultiplier ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <AiProse title="Why this draft" body={result.rationale} />
          <AiProse title="Uncertainty" body={result.uncertainty} />
          <AiLineList title="Assumptions" items={result.assumptions} />
          <AiSourceRefs refs={result.sourceRefs} />

          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-2xs leading-relaxed text-amber-900">
            Nothing has been created or changed. “Use in new version” copies this draft into the
            scenario form, where every field is editable and the set is only published when you
            submit it — an AI draft can never activate a scenario, alter a weighting in force, or
            run the engine.
          </p>
        </>
      )}
    </AiResponseFrame>
  );
}
