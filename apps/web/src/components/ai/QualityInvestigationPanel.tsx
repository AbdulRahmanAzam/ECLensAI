/**
 * Investigate with AI — the data quality investigator.
 *
 * Read-only by construction, and the panel says so rather than merely being so.
 * A suggested correction is rendered as text a reviewer can carry to the import
 * screen; there is no apply button, because the server exposes no tool that would
 * let one exist and a correction that changed a persisted figure on a model's say
 * is the failure the whole feature is built to prevent. Destructive suggestions
 * are called out as destructive for the same reason: the reviewer needs to know
 * what applying one by hand would cost.
 */
import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import type { DataQualityInvestigation, InvestigateQualityRequest } from '@eclens/shared';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useAiFeature } from '@/hooks/useAi';
import { SEVERITY_TONE } from '@/lib/ai';
import { AiCaveats, AiConfidenceBadge, AiProse, AiSourceRefs } from './AiChrome';
import { AiResponseFrame } from './AiResponseFrame';

export interface QualityInvestigationPanelProps {
  /** Exactly one of the three ids, matching what the route enforces. */
  request: Omit<InvestigateQualityRequest, 'focus'>;
  title?: string;
  /** Names the subject in the idle copy, e.g. "exception EXP-014". */
  subjectLabel?: string;
}

export function QualityInvestigationPanel({ request, title, subjectLabel }: QualityInvestigationPanelProps) {
  const [focus, setFocus] = useState('');
  const investigate = useAiFeature<InvestigateQualityRequest, DataQualityInvestigation>(api.ai.investigateQuality);

  const input: InvestigateQualityRequest = focus.trim() ? { ...request, focus: focus.trim() } : request;
  const ask = () => investigate.run(input);

  return (
    <AiResponseFrame<DataQualityInvestigation>
      response={investigate.response}
      failure={investigate.failure}
      isPending={investigate.isPending}
      title={title ?? 'Investigate with AI'}
      description="Patterns across the quarantined records, read from this organisation’s stored issues. Nothing here changes data."
      actions={
        <Button
          size="sm"
          variant={investigate.response ? 'secondary' : 'primary'}
          icon={<Sparkles className="h-4 w-4" />}
          loading={investigate.isPending}
          onClick={ask}
        >
          {investigate.response ? 'Investigate again' : 'Investigate with AI'}
        </Button>
      }
      onRetry={ask}
      tags={
        investigate.response?.result ? (
          <AiConfidenceBadge label={investigate.response.result.confidenceLabel} />
        ) : undefined
      }
      idle={
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-500">
            Nothing has been investigated yet. Ask about {subjectLabel ?? 'these records'} and the answer will group the
            stored data quality issues into patterns, each with the count it affects and a bounded sample of examples.
          </p>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Focus the investigation (optional)
            </span>
            <input
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              maxLength={1000}
              placeholder="e.g. why are so many PDs arriving as whole numbers?"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
            />
          </label>
        </div>
      }
    >
      {(result) => (
        <>
          <AiProse title="What the stored issues show" body={result.overview} />

          {result.patterns.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">Patterns</p>
              <ul className="space-y-2">
                {result.patterns.map((pattern) => (
                  <li key={pattern.code} className="rounded-md border border-slate-200 bg-white px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={SEVERITY_TONE[pattern.severity]}>{pattern.severity.toLowerCase()}</Badge>
                      <span className="text-xs font-medium text-navy-900">{pattern.title}</span>
                      <span className="tabular-nums text-[11px] text-slate-500">
                        {pattern.affectedCount} record{pattern.affectedCount === 1 ? '' : 's'}
                      </span>
                      <code className="ml-auto font-mono text-[10px] text-slate-400">{pattern.code}</code>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                      {pattern.explanation}
                    </p>
                    {pattern.examples.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5 border-l-2 border-slate-200 pl-2">
                        {pattern.examples.map((example, index) => (
                          <li key={index} className="font-mono text-[11px] leading-relaxed text-slate-500">
                            {example}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.suggestedCorrections.length > 0 ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                <AlertTriangle className="h-3 w-3" />
                Suggested corrections — read only
              </p>
              <ul className="space-y-2">
                {result.suggestedCorrections.map((correction, index) => (
                  <li key={`${correction.patternCode}-${index}`} className="text-xs leading-relaxed text-slate-700">
                    <span className="font-medium">{correction.field}</span>
                    {correction.destructive ? (
                      <Badge tone="danger" className="ml-1.5">
                        destructive
                      </Badge>
                    ) : null}
                    <span className="text-slate-400"> · pattern {correction.patternCode}</span>
                    <p className="mt-0.5">{correction.suggestedCorrection}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{correction.rationale}</p>
                  </li>
                ))}
              </ul>
              {/*
                Stated in the panel rather than left for the reviewer to infer from
                the absence of a button. An unexplained missing affordance reads as
                a bug; a named one reads as policy.
              */}
              <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-relaxed text-slate-500">
                These cannot be applied from here, by design. Correct the source file and re-import it so the change is
                visible in the batch, or triage each record individually — either way a person makes the change and the
                audit trail records who.
              </p>
            </div>
          ) : null}

          <AiCaveats items={result.caveats} />
          <AiSourceRefs refs={result.sourceRefs} />
        </>
      )}
    </AiResponseFrame>
  );
}
