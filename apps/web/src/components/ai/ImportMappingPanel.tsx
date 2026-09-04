/**
 * Smart Import Mapper.
 *
 * The deterministic header matcher in `packages/shared/src/ingest/columns.ts`
 * already proposes a mapping, and it proposes the same one every time for the
 * same file. This panel exists for the files it cannot read — a column headed
 * "Outstanding Principal (PKR '000)" — and it is shown *beside* the deterministic
 * answer rather than in place of it, so a reviewer can see where the two disagree
 * instead of having to remember what was there before.
 *
 * Nothing here applies anything. The suggestions go to the existing mapping form,
 * which stays editable, and the mapping is only written when the reviewer presses
 * that form's own button.
 */
import { ArrowRight, Sparkles } from 'lucide-react';
import type { AiImportMappingRequest, ImportMappingSuggestion, ImportMappingSuggestionSet } from '@eclens/shared';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useAiFeature } from '@/hooks/useAi';
import { MAPPING_CONFIDENCE_TONE, mappingConfidenceLabel } from '@/lib/ai';
import { AiCaveats } from './AiChrome';
import { AiResponseFrame } from './AiResponseFrame';

export interface ImportMappingPanelProps {
  batchId: string;
  /** Names the batch in the idle copy, e.g. its file name. */
  batchLabel?: string;
  /** Hands the accepted suggestions to the page's existing mapping form. */
  onUseSuggestions: (suggestions: ImportMappingSuggestion[]) => void;
}

export function ImportMappingPanel({ batchId, batchLabel, onUseSuggestions }: ImportMappingPanelProps) {
  const mapping = useAiFeature<AiImportMappingRequest, ImportMappingSuggestionSet>(api.ai.suggestImportMapping);

  const ask = () => mapping.run({ batchId });
  const result = mapping.response?.result;

  return (
    <AiResponseFrame<ImportMappingSuggestionSet>
      response={mapping.response}
      failure={mapping.failure}
      isPending={mapping.isPending}
      title="AI mapping suggestions"
      description="Reads the batch’s headers and a sample of its rows. Shown beside the deterministic proposal, never instead of it."
      actions={
        result ? (
          <>
            <Badge tone="warning">approval required</Badge>
            <Button
              size="sm"
              icon={<ArrowRight className="h-4 w-4" />}
              disabled={result.suggestions.every((suggestion) => suggestion.targetField === null)}
              onClick={() => onUseSuggestions(result.suggestions)}
            >
              Use as a starting point
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            icon={<Sparkles className="h-4 w-4" />}
            loading={mapping.isPending}
            onClick={ask}
          >
            {mapping.response ? 'Suggest again' : 'Suggest mapping'}
          </Button>
        )
      }
      onRetry={ask}
      idle={
        <p className="text-xs leading-relaxed text-slate-500">
          Nothing has been suggested yet. Ask for a mapping of {batchLabel ?? 'this batch'} and each source column comes
          back with the canonical field proposed for it, the unit the model read, its confidence, and the reasoning. A
          column it cannot place is left unmapped rather than guessed at.
        </p>
      }
    >
      {(set) => (
        <>
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2.5 py-2 font-medium">Source column</th>
                  <th className="px-2.5 py-2 font-medium">Proposed field</th>
                  <th className="px-2.5 py-2 font-medium">Confidence</th>
                  <th className="px-2.5 py-2 font-medium">Unit read</th>
                  <th className="px-2.5 py-2 font-medium">Deterministic proposal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {set.suggestions.map((suggestion) => {
                  const deterministic = set.deterministicSuggestions.find(
                    (entry) => entry.field === suggestion.targetField,
                  );
                  // Flagged rather than hidden: where the two disagree, the
                  // disagreement is the single most useful thing on the row.
                  const disagrees =
                    suggestion.targetField !== null &&
                    deterministic !== undefined &&
                    deterministic.header !== null &&
                    deterministic.header !== suggestion.sourceColumn;
                  return (
                    <tr key={suggestion.sourceColumn}>
                      <td className="px-2.5 py-2 font-medium text-slate-800">{suggestion.sourceColumn}</td>
                      <td className="px-2.5 py-2">
                        {suggestion.targetField ? (
                          <code className="font-mono text-[11px] text-navy-800">{suggestion.targetField}</code>
                        ) : (
                          <span className="text-[11px] text-slate-400">left unmapped</span>
                        )}
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                          {suggestion.rationale}
                        </span>
                      </td>
                      <td className="px-2.5 py-2">
                        <Badge tone={MAPPING_CONFIDENCE_TONE[suggestion.confidenceLevel]}>
                          {mappingConfidenceLabel(suggestion.confidenceLevel)}
                        </Badge>
                        <span className="ml-1.5 tabular-nums text-[11px] text-slate-400">
                          {(suggestion.confidence * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-2.5 py-2">
                        <code className="font-mono text-[11px] text-slate-600">{suggestion.detectedUnit}</code>
                      </td>
                      <td className="px-2.5 py-2 text-[11px] text-slate-500">
                        {deterministic?.header ?? <span className="text-slate-400">none</span>}
                        {disagrees ? <Badge tone="warning" className="ml-1.5">disagrees</Badge> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/*
            Warnings are rendered under the table rather than inline because they
            are per-column prose and a table cell holding three of them stops being
            a table. Each is prefixed with the column it belongs to.
          */}
          {set.suggestions.some((suggestion) => suggestion.warnings.length > 0) ? (
            <AiCaveats
              title="Column warnings"
              items={set.suggestions.flatMap((suggestion) =>
                suggestion.warnings.map((warning) => `${suggestion.sourceColumn}: ${warning}`),
              )}
            />
          ) : null}

          {set.unmappedColumns.length > 0 ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              <span className="font-medium text-slate-600">Columns with no canonical counterpart:</span>{' '}
              {set.unmappedColumns.join(', ')}. They are ignored on import; nothing is inferred from them.
            </p>
          ) : null}

          {set.missingRequiredFields.length > 0 ? (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700"
              role="alert"
            >
              Still missing required fields after this proposal:{' '}
              {set.missingRequiredFields.map((field, index) => (
                <span key={field}>
                  {index > 0 ? ', ' : null}
                  <code className="font-mono">{field}</code>
                </span>
              ))}
              . The batch cannot be committed until a column supplies each of them — the AI does not fill gaps.
            </p>
          ) : null}

          <AiCaveats items={set.caveats} />

          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
            Nothing has been mapped. “Use as a starting point” fills the column mapping form below, where every field
            stays editable; the mapping is only written when you apply it yourself, and the batch is re-validated
            against the real parser afterwards.
          </p>
        </>
      )}
    </AiResponseFrame>
  );
}
