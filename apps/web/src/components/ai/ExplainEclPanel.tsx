/**
 * Explain This ECL.
 *
 * The exposure page and the run page already show every number in the trace.
 * What this panel adds is the sentence a reviewer writes next to them — and the
 * discipline that makes the sentence worth reading is that the server built it
 * from the trace and refused to return it if a figure in the prose could not be
 * found in the records the model was handed.
 *
 * So the panel's job is to show the reconciliation alongside its citations rather
 * than to decorate the answer: an explanation whose arithmetic cannot be replayed
 * against a source is worse than no explanation, because it reads as settled.
 */
import { Sparkles } from 'lucide-react';
import type { EclExplanation, ExplainEclRequest } from '@eclens/shared';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { useAiFeature } from '@/hooks/useAi';
import { AiCaveats, AiConfidenceBadge, AiLineList, AiProse, AiSourceRefs } from './AiChrome';
import { AiResponseFrame } from './AiResponseFrame';

export interface ExplainEclPanelProps {
  exposureId: string;
  /** Omitted on the exposure page, where the latest stored result is explained. */
  runId?: string;
  /** Names the subject in the idle copy, e.g. an exposure's public id. */
  subjectLabel?: string;
}

export function ExplainEclPanel({ exposureId, runId, subjectLabel }: ExplainEclPanelProps) {
  const explain = useAiFeature<ExplainEclRequest, EclExplanation>(api.ai.explainEcl);

  const input: ExplainEclRequest = runId ? { exposureId, runId } : { exposureId };
  const ask = () => explain.run(input);

  return (
    <AiResponseFrame<EclExplanation>
      response={explain.response}
      failure={explain.failure}
      isPending={explain.isPending}
      title="Explain this ECL"
      description="In words, from the stored calculation trace. No figure here is produced by the model."
      actions={
        <Button
          size="sm"
          variant={explain.response ? 'secondary' : 'primary'}
          icon={<Sparkles className="h-4 w-4" />}
          loading={explain.isPending}
          onClick={ask}
        >
          {explain.response ? 'Explain again' : 'Explain this ECL'}
        </Button>
      }
      onRetry={ask}
      tags={
        explain.response?.result ? (
          <AiConfidenceBadge label={explain.response.result.confidenceLabel} />
        ) : undefined
      }
      idle={
        <p className="text-xs leading-relaxed text-slate-500">
          Nothing has been asked yet.
          {subjectLabel
            ? ` Explain the allowance for ${subjectLabel}`
            : ' Explain the allowance for this exposure'}{' '}
          and the answer will be written from the stored trace, with the run and exposure it came
          from cited underneath.
        </p>
      }
    >
      {(result) => (
        <>
          <AiProse title="Summary" body={result.summary} />
          <AiProse title="Why this stage" body={result.stageExplanation} />
          <AiProse title="Why this horizon" body={result.horizonExplanation} />
          <AiLineList title="Scenario contributions" items={result.scenarioContributions} />
          <AiLineList title="Key parameters" items={result.keyParameters} />
          {/*
            Shown as its own block and last before the caveats: this is the part an
            auditor replays, and burying it inside the prose would make it the one
            thing nobody checks.
          */}
          <AiLineList title="Reconciliation" items={result.reconciliation} />
          <AiCaveats items={result.caveats} />
          <AiSourceRefs refs={result.sourceRefs} />
        </>
      )}
    </AiResponseFrame>
  );
}
