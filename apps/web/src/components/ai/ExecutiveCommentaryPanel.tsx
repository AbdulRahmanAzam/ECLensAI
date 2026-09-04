/**
 * Executive Commentary.
 *
 * The one AI output designed to leave this application — it gets pasted into a
 * board pack — which is why two things are non-negotiable here and merely nice
 * elsewhere. Every movement carries its claim kind, because a reader of the
 * finished pack has no other way to tell a stored figure from the model's reading
 * of it. And the copy action writes that labelling into the text itself, so the
 * distinction survives the paste.
 *
 * The panel drafts. It does not publish, export a report, or record an approval;
 * there is no such tool on the server and nothing here calls one.
 */
import { useState } from 'react';
import { Copy, Sparkles } from 'lucide-react';
import type { CommentaryMovement, ExecutiveCommentary, ExecutiveCommentaryRequest } from '@eclens/shared';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useAiFeature } from '@/hooks/useAi';
import { CLAIM_TONE, claimKindLabel, commentaryToClipboardText } from '@/lib/ai';
import { copyText } from '@/lib/utils';
import { AiConfidenceBadge, AiLineList, AiProse, AiSourceRefs } from './AiChrome';
import { AiResponseFrame } from './AiResponseFrame';

function MovementList({ title, movements }: { title: string; movements: CommentaryMovement[] }) {
  if (movements.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</p>
      <ul className="space-y-2">
        {movements.map((movement, index) => (
          <li key={`${movement.claimKind}-${index}`} className="rounded-md border border-slate-200 bg-white px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={CLAIM_TONE[movement.claimKind]}>{claimKindLabel(movement.claimKind)}</Badge>
              <span className="text-xs font-medium text-navy-900">{movement.label}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{movement.detail}</p>
            {movement.sourceRefs.length > 0 ? (
              <div className="mt-1.5">
                <AiSourceRefs refs={movement.sourceRefs} title="" />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ExecutiveCommentaryPanelProps {
  runId: string;
  /** Names the run in the idle copy, e.g. its public id. */
  runLabel?: string;
}

export function ExecutiveCommentaryPanel({ runId, runLabel }: ExecutiveCommentaryPanelProps) {
  const { push } = useToast();
  const [audience, setAudience] = useState('');
  const commentary = useAiFeature<ExecutiveCommentaryRequest, ExecutiveCommentary>(api.ai.executiveCommentary);

  const input: ExecutiveCommentaryRequest = audience.trim() ? { runId, audience: audience.trim() } : { runId };
  const ask = () => commentary.run(input);

  const copy = async () => {
    const result = commentary.response?.result;
    if (!result) return;
    const copied = await copyText(commentaryToClipboardText(result));
    push(
      copied ? 'success' : 'error',
      copied ? 'Commentary copied' : 'Copy failed',
      copied
        ? 'Sources and claim labels are included in the text.'
        : 'This browser would not write to the clipboard.',
    );
  };

  return (
    <AiResponseFrame<ExecutiveCommentary>
      response={commentary.response}
      failure={commentary.failure}
      isPending={commentary.isPending}
      title="Executive commentary"
      description="A drafted narrative for this run. Every figure is copied from stored records; the framing is the model's."
      actions={
        <>
          {commentary.response?.result ? (
            <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => void copy()}>
              Copy
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={commentary.response ? 'secondary' : 'primary'}
            icon={<Sparkles className="h-4 w-4" />}
            loading={commentary.isPending}
            onClick={ask}
          >
            {commentary.response ? 'Redraft' : 'Draft commentary'}
          </Button>
        </>
      }
      onRetry={ask}
      tags={
        commentary.response?.result ? (
          <AiConfidenceBadge label={commentary.response.result.confidenceLabel} />
        ) : undefined
      }
      idle={
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-500">
            Nothing has been drafted yet. A commentary for {runLabel ?? 'this run'} will be written from the stored run
            result, its snapshot and the scenario weights in force, with each claim labelled as a fact, an inference or a
            recommendation.
          </p>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Audience (optional)</span>
            <input
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              maxLength={120}
              placeholder="ALCO, board risk committee…"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
            />
          </label>
        </div>
      }
    >
      {(result) => (
        <>
          <p className="text-base font-semibold leading-snug text-navy-950">{result.headline}</p>
          <AiProse title="Overview" body={result.overview} />
          <MovementList title="Key movements" movements={result.keyMovements} />
          <MovementList title="Risk concentrations" movements={result.riskConcentrations} />
          <MovementList title="Recommended actions" movements={result.actions} />
          <AiLineList title="Data limitations" items={result.dataLimitations} />
          <AiSourceRefs refs={result.sourceRefs} />
        </>
      )}
    </AiResponseFrame>
  );
}
