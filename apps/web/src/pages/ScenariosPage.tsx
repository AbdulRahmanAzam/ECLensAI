/**
 * Versioned scenario sets (implementation tasks 3 and 10, acceptance criterion 4).
 *
 * A scenario set is never edited in place: `POST /scenario-sets` rejects a
 * name+version pair that already exists, so changing an assumption means
 * creating a new version. `lockedByRunCount` is the visible proof of that rule —
 * it counts the runs frozen to this version, and a set that has locked runs can
 * be superseded but can never be rewritten underneath them.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  Info,
  Lock,
  Minus,
  Plus,
  TrendingDown,
  TrendingUp,
  Trash2,
} from 'lucide-react';
import type { MacroIndicators, ScenarioSetRecord } from '@eclens/shared';
import {
  decimalStringToNumber,
  formatDateTime,
  formatDecimalText,
  formatPercent,
} from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { ScenarioDraftPanel } from '@/components/ai/ScenarioDraftPanel';
import { Badge, SyntheticBadge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';

/** `ScenarioRecord.kind` is a free string on the wire — extra scenarios beyond the three defaults are allowed. */
const KIND_TONE: Record<string, BadgeTone> = {
  BASE: 'info',
  UPSIDE: 'positive',
  DOWNSIDE: 'danger',
};

function kindTone(kind: string): BadgeTone {
  return KIND_TONE[kind.toUpperCase()] ?? 'neutral';
}

function kindIcon(kind: string) {
  const upper = kind.toUpperCase();
  if (upper === 'UPSIDE') return <TrendingUp className="h-4 w-4" />;
  if (upper === 'DOWNSIDE') return <TrendingDown className="h-4 w-4" />;
  return <Minus className="h-4 w-4" />;
}

const INDICATOR_LABELS: Array<{ key: keyof MacroIndicators; label: string }> = [
  { key: 'gdpGrowth', label: 'GDP growth' },
  { key: 'inflationRate', label: 'Inflation' },
  { key: 'unemploymentRate', label: 'Unemployment' },
  { key: 'policyRate', label: 'Policy rate' },
];

/**
 * Browser-side sanity check only. The authoritative validation is the engine's,
 * which sums the weights in exact decimal arithmetic and rejects a set that does
 * not total 1 within its documented tolerance — see `resolveScenarioSet`.
 */
function activeWeightSum(scenarios: Array<{ weight: string; isActive: boolean }>): number {
  return scenarios
    .filter((scenario) => scenario.isActive)
    .reduce((total, scenario) => total + decimalStringToNumber(scenario.weight), 0);
}

const totalsOne = (sum: number): boolean => Math.abs(sum - 1) < 1e-9;

interface DraftScenario {
  code: string;
  name: string;
  weight: string;
  pdMultiplier: string;
  lgdMultiplier: string;
  isActive: boolean;
  description: string;
}

const BLANK_SCENARIO: DraftScenario = {
  code: '',
  name: '',
  weight: '0',
  pdMultiplier: '1',
  lgdMultiplier: '1',
  isActive: true,
  description: '',
};

function ScenarioSetCard({ set, canApprove }: { set: ScenarioSetRecord; canApprove: boolean }) {
  const sum = activeWeightSum(set.scenarios);
  const { push } = useToast();
  const queryClient = useQueryClient();

  const approve = useMutation({
    mutationFn: () => api.scenarios.approve(set.id),
    onSuccess: (updated) => {
      push(
        'success',
        'Scenario set approved',
        `${updated.name} v${updated.version} can now be used to create a run.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['scenario-sets'] });
    },
    onError: (error) =>
      push(
        'error',
        'Approval failed',
        error instanceof ApiError ? error.message : 'The scenario set could not be approved.',
      ),
  });

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {set.name}
            <Badge tone="neutral">v{set.version}</Badge>
            {set.isActive ? (
              <Badge tone="positive">active</Badge>
            ) : (
              <Badge tone="neutral">superseded</Badge>
            )}
            {set.approvalStatus === 'APPROVED' ? (
              <Badge tone="positive">
                <CheckCircle2 className="mr-1 inline h-3 w-3" />
                approved
              </Badge>
            ) : (
              <Badge tone="warning">
                <Clock className="mr-1 inline h-3 w-3" />
                pending approval
              </Badge>
            )}
          </span>
        }
        description={
          set.lockedByRunCount > 0 ? (
            <span className="flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Frozen by {set.lockedByRunCount} run{set.lockedByRunCount === 1 ? '' : 's'}
            </span>
          ) : (
            'Not yet locked by any run'
          )
        }
        actions={
          set.approvalStatus === 'PENDING' && canApprove ? (
            <Button
              size="sm"
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              loading={approve.isPending}
              onClick={() => approve.mutate()}
            >
              Approve for use
            </Button>
          ) : undefined
        }
      />
      <CardContent className="space-y-4">
        {set.description ? (
          <p className="text-xs leading-relaxed text-slate-600">{set.description}</p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-2xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Scenario</th>
                <th className="py-2 pr-3 font-medium">Weight</th>
                <th className="py-2 pr-3 font-medium">PD multiplier</th>
                <th className="py-2 pr-3 font-medium">LGD multiplier</th>
                <th className="py-2 pr-3 font-medium">Macro indicators</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {set.scenarios.map((scenario) => (
                <tr key={scenario.id} className={scenario.isActive ? '' : 'opacity-60'}>
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span className={scenario.isActive ? 'text-navy-700' : 'text-slate-400'}>
                        {kindIcon(scenario.kind)}
                      </span>
                      <span>
                        <span className="block font-medium text-slate-800">{scenario.name}</span>
                        <code className="block font-mono text-2xs text-slate-400">
                          {scenario.code}
                        </code>
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-slate-800">
                    {formatDecimalText(scenario.weight)}
                    <span className="ml-1.5 text-2xs text-slate-400">
                      {formatPercent(decimalStringToNumber(scenario.weight), 0)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-slate-700">
                    × {formatDecimalText(scenario.pdMultiplier)}
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-slate-700">
                    × {formatDecimalText(scenario.lgdMultiplier)}
                  </td>
                  <td className="py-2.5 pr-3">
                    {scenario.indicators ? (
                      <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-slate-500">
                        {INDICATOR_LABELS.map((indicator) => (
                          <span key={indicator.key}>
                            {indicator.label}{' '}
                            <span className="tabular-nums text-slate-700">
                              {formatPercent(scenario.indicators?.[indicator.key] ?? 0, 1)}
                            </span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-2xs text-slate-400">none recorded</span>
                    )}
                  </td>
                  <td className="py-2.5">
                    <Badge tone={kindTone(scenario.kind)}>
                      {scenario.isActive ? 'active' : 'inactive'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Active weights total</span>
            <span className="font-semibold tabular-nums text-navy-900">
              {formatPercent(sum, 2)}
            </span>
            {totalsOne(sum) ? (
              <Badge tone="positive">valid</Badge>
            ) : (
              <Badge tone="danger">must equal 100%</Badge>
            )}
          </div>
          <p className="text-2xs text-slate-400">
            Created by {set.createdBy} on {formatDateTime(set.createdAt)}
            {set.approvedBy && set.approvedAt ? (
              <>
                {' '}
                · Approved by {set.approvedBy} on {formatDateTime(set.approvedAt)}
              </>
            ) : null}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ScenariosPage() {
  const { can } = useAuth();
  const { money } = useSettings();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [description, setDescription] = useState('');
  const [scenarios, setScenarios] = useState<DraftScenario[]>([{ ...BLANK_SCENARIO }]);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['scenario-sets'],
    queryFn: () =>
      api.scenarios.list({ page: 1, pageSize: 50, sortDir: 'desc', sortBy: 'createdAt' }),
  });
  /** Baseline for the indicative preview only — never the number a run reports. */
  const { data: currentSummary } = useQuery({
    queryKey: ['analytics-summary', {}],
    queryFn: () => api.analytics.summary(),
  });

  const canWrite = can('scenario:write');
  const canApprove = can('scenario:approve');
  const canUseAi = can('ai:use');
  const sets = data?.items ?? [];
  /** The draft is expressed against the set actually in force, not a superseded one. */
  const activeSetId = sets.find((set) => set.isActive)?.id;

  const create = useMutation({
    mutationFn: () =>
      api.scenarios.create({
        name: name.trim(),
        version: version.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
        scenarios: scenarios.map((scenario) => ({
          code: scenario.code.trim(),
          name: scenario.name.trim(),
          weight: scenario.weight.trim(),
          pdMultiplier: scenario.pdMultiplier.trim(),
          lgdMultiplier: scenario.lgdMultiplier.trim(),
          isActive: scenario.isActive,
          description: scenario.description.trim() === '' ? undefined : scenario.description.trim(),
        })),
      }),
    onSuccess: (created) => {
      push(
        'success',
        'Scenario set created',
        `${created.name} v${created.version} is now the active set. Runs already completed keep the version they were locked to.`,
      );
      setCreateOpen(false);
      setName('');
      setVersion('');
      setDescription('');
      setScenarios([{ ...BLANK_SCENARIO }]);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['scenario-sets'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
    },
    onError: (error) => {
      // The engine, not this form, decides whether the weights are admissible —
      // surface its verdict verbatim rather than paraphrasing it.
      const message =
        error instanceof ApiError ? error.message : 'The scenario set could not be created.';
      setFormError(message);
      push('error', 'Scenario set rejected', message);
    },
  });

  const patchScenario = (index: number, patch: Partial<DraftScenario>) => {
    setScenarios((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const draftSum = activeWeightSum(scenarios);
  /**
   * Indicative only: the weighted-average of (PD multiplier × LGD multiplier)
   * across active draft scenarios, applied as a flat scalar to the current
   * book's stored allowance. The real engine reprices every exposure period
   * by period under each scenario in exact decimal arithmetic — this is a
   * single-number approximation to show direction and rough magnitude before
   * that calculation runs, mirroring the engine's own `educationalApproximation`
   * framing (never the reported figure).
   */
  const indicativeSeverity = scenarios
    .filter((scenario) => scenario.isActive)
    .reduce((total, scenario) => {
      const weight = decimalStringToNumber(scenario.weight || '0');
      const pd = decimalStringToNumber(scenario.pdMultiplier || '1');
      const lgd = decimalStringToNumber(scenario.lgdMultiplier || '1');
      return total + weight * pd * lgd;
    }, 0);
  const currentAllowance = currentSummary
    ? decimalStringToNumber(currentSummary.totals.lossAllowance)
    : null;
  const indicativeAllowance =
    currentAllowance !== null && totalsOne(draftSum) ? currentAllowance * indicativeSeverity : null;

  const draftValid =
    name.trim().length >= 3 &&
    version.trim().length >= 1 &&
    scenarios.every((scenario) => scenario.code.trim() !== '' && scenario.name.trim() !== '') &&
    totalsOne(draftSum);

  return (
    <div>
      <PageHeader
        title="Macro scenarios"
        description="Versioned scenario sets. Every exposure is priced under each active scenario and the results are combined with the weights below — in exact decimal arithmetic, by the deterministic engine."
        tags={<SyntheticBadge />}
        actions={
          canWrite ? (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
              New version
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-navy-200 bg-navy-50 px-4 py-2.5 text-2xs leading-relaxed text-navy-800">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Scenario sets are immutable once created. Editing an assumption means publishing a new
          version; runs that already completed stay locked to the version they used, which is why
          each card shows how many runs froze it.
        </span>
      </div>

      {canWrite && canUseAi ? (
        <div className="mb-4" data-tour="tour-scenario-draft">
          <ScenarioDraftPanel
            scenarioSetId={activeSetId}
            onUseDraft={(draft) => {
              // Prefills the form and opens it. The version is left blank on
              // purpose: the model proposes weightings, never the identity of the
              // version they will be published under, and a set that silently
              // overwrote a version number would look like an edit to an
              // immutable record.
              setName(draft.name);
              setDescription(draft.description);
              setScenarios(draft.scenarios.map((scenario) => ({ ...scenario })));
              setFormError(null);
              setCreateOpen(true);
            }}
          />
        </div>
      ) : null}

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : sets.length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="h-8 w-8" />}
          title="No scenario sets yet"
          description="Create a versioned set of base, upside and downside scenarios before running the engine."
          action={
            canWrite ? (
              <Button onClick={() => setCreateOpen(true)}>New scenario set</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {sets.map((set) => (
            <ScenarioSetCard key={set.id} set={set} canApprove={canApprove} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New scenario set version"
        description="Creating a version never mutates an existing one. Weights are decimal strings and active weights must total exactly 1."
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!draftValid}
              onClick={() => create.mutate()}
            >
              Create version
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Pakistan macro base case"
            />
            <Input
              label="Version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="1.1.0"
              hint="Must not repeat an existing name + version."
            />
          </div>
          <Input
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional context for reviewers"
          />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-slate-800">Scenarios</p>
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setScenarios((current) => [...current, { ...BLANK_SCENARIO }])}
              >
                Add scenario
              </Button>
            </div>

            {scenarios.map((scenario, index) => (
              <div key={index} className="rounded-lg border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Code"
                    value={scenario.code}
                    onChange={(event) => patchScenario(index, { code: event.target.value })}
                    placeholder="BASE"
                  />
                  <Input
                    label="Name"
                    value={scenario.name}
                    onChange={(event) => patchScenario(index, { name: event.target.value })}
                    placeholder="Base case"
                  />
                  <Input
                    label="Weight (decimal)"
                    value={scenario.weight}
                    onChange={(event) => patchScenario(index, { weight: event.target.value })}
                    placeholder="0.5"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="PD ×"
                      value={scenario.pdMultiplier}
                      onChange={(event) =>
                        patchScenario(index, { pdMultiplier: event.target.value })
                      }
                    />
                    <Input
                      label="LGD ×"
                      value={scenario.lgdMultiplier}
                      onChange={(event) =>
                        patchScenario(index, { lgdMultiplier: event.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={scenario.isActive}
                      onChange={(event) => patchScenario(index, { isActive: event.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-navy-700 focus:ring-navy-500"
                    />
                    Active — included in the weighted result
                  </label>
                  {scenarios.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      onClick={() =>
                        setScenarios((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}

            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-500">Active weights total</span>
              <span className="font-semibold tabular-nums text-navy-900">
                {formatPercent(draftSum, 2)}
              </span>
              {totalsOne(draftSum) ? (
                <Badge tone="positive">valid</Badge>
              ) : (
                <Badge tone="danger">must equal 100%</Badge>
              )}
            </div>

            {indicativeAllowance !== null ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                    <Badge tone="warning">Indicative</Badge>
                    Estimated allowance under this draft
                  </span>
                  <span className="font-semibold tabular-nums text-amber-900">
                    {money(indicativeAllowance, { compact: true })}
                  </span>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-amber-800">
                  A weight-and-multiplier scalar applied to the book's current stored allowance (
                  {money(currentAllowance ?? 0, { compact: true })}) — not the calculated result.
                  The engine reprices every exposure period by period under each scenario; run it
                  after saving to get the exact figure.
                </p>
              </div>
            ) : null}
          </div>

          {formError ? (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              role="alert"
            >
              {formError}
            </p>
          ) : (
            <p className="text-2xs leading-relaxed text-slate-500">
              PD multipliers are applied in hazard space, so a downside multiplier can never push a
              cumulative default probability past 1. The total above is a browser-side sanity check;
              the server re-validates the whole set in exact decimal arithmetic before it is
              accepted.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
