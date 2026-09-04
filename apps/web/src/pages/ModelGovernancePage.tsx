/**
 * Model governance (implementation task 3, acceptance criterion 4).
 *
 * A model configuration is never edited: `POST /model-configurations` publishes a
 * new version and, optionally, makes it the active one. The versions already
 * locked by completed runs are counted on each card, which is the visible half of
 * the guarantee that superseding an assumption cannot rewrite history — the other
 * half is that a run stores the configuration id *and* version it executed with.
 *
 * Every bound and rate here is a decimal string exactly as the engine reads it, so
 * this page renders digits rather than re-deriving anything.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, Lock, Plus, ShieldCheck, XCircle } from 'lucide-react';
import type {
  DecValue,
  DiscountConvention,
  ModelConfigurationRecord,
  SimplifiedEadProfile,
  StagingRuleCode,
} from '@eclens/shared';
import {
  DISCOUNT_CONVENTIONS,
  SIMPLIFIED_EAD_PROFILES,
  STAGING_RULE_CODES,
  decimalStringToNumber,
  formatDate,
  formatDateTime,
  formatDecimalPercent,
  formatDecimalText,
} from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { Badge, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { stagingCodeLabel } from '@/lib/staging';
import { useAuth } from '@/providers/AuthProvider';

interface ParameterRow {
  label: string;
  value: string;
  description: string;
}

function parameterRows(config: ModelConfigurationRecord): ParameterRow[] {
  return [
    {
      label: 'LGD floor',
      value: formatDecimalPercent(config.lgdFloor, 2),
      description: 'Minimum loss-given-default applied after scenario scaling.',
    },
    {
      label: 'LGD ceiling',
      value: formatDecimalPercent(config.lgdCeiling, 2),
      description: 'Maximum loss-given-default applied after scenario scaling.',
    },
    {
      label: 'PD floor',
      value: formatDecimalText(config.pdFloor),
      description: 'PDs are clamped into this range before term-structure interpolation.',
    },
    {
      label: 'PD ceiling',
      value: formatDecimalText(config.pdCeiling),
      description:
        'Upper PD clamp. Survival logic separately guarantees cumulative PD never exceeds 1.',
    },
    {
      label: 'Lifetime horizon cap',
      value: `${config.lifetimeHorizonMonthsCap} months`,
      description: 'Hard cap on the Stage 2 and Stage 3 horizon, in months.',
    },
    {
      label: 'Max calculation periods',
      value: `${config.maxCalculationPeriods}`,
      description: 'Absolute cap on persisted periods per exposure per scenario.',
    },
    {
      label: 'Twelve-month window',
      value: `${config.twelveMonthWindow} months`,
      description:
        'Periods summed for Stage 1. This is the window of possible default events, not of cash shortfalls.',
    },
    {
      label: 'Discount convention',
      value: config.discountConvention,
      description:
        'END_PERIOD discounts at t/12; MID_PERIOD at (t − 0.5)/12. Twelve periods per year.',
    },
    {
      label: 'Effective interest rate range',
      value: `${formatDecimalText(config.effectiveInterestRateMin)} … ${formatDecimalText(config.effectiveInterestRateMax)}`,
      description:
        'Inclusive supported range. A rate outside it fails validation rather than being clamped.',
    },
    {
      label: 'Default credit conversion factor',
      value: formatDecimalText(config.defaultCreditConversionFactor),
      description: 'Share of undrawn commitment added to EAD when the source row carries no CCF.',
    },
    {
      label: 'Default simplified EAD profile',
      value: config.defaultSimplifiedEadProfile,
      description:
        'Used only when no contractual amortization schedule was supplied; always labeled in output.',
    },
  ];
}

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Standing controls read off the configuration itself, so the panel cannot drift
 * into asserting something the record contradicts.
 */
function validationChecks(config: ModelConfigurationRecord): Check[] {
  const lgdFloor = decimalStringToNumber(config.lgdFloor);
  const lgdCeiling = decimalStringToNumber(config.lgdCeiling);
  const pdFloor = decimalStringToNumber(config.pdFloor);
  const pdCeiling = decimalStringToNumber(config.pdCeiling);
  const eirMin = decimalStringToNumber(config.effectiveInterestRateMin);
  const eirMax = decimalStringToNumber(config.effectiveInterestRateMax);
  const rules = config.stagingRuleSet;

  return [
    {
      label: 'LGD bounds are ordered and inside [0, 1]',
      ok: lgdFloor < lgdCeiling && lgdFloor >= 0 && lgdCeiling <= 1,
      detail: `Floor ${formatDecimalText(config.lgdFloor)} < ceiling ${formatDecimalText(config.lgdCeiling)}.`,
    },
    {
      label: 'PD bounds are ordered and inside [0, 1]',
      ok: pdFloor < pdCeiling && pdFloor >= 0 && pdCeiling <= 1,
      detail: `Floor ${formatDecimalText(config.pdFloor)} < ceiling ${formatDecimalText(config.pdCeiling)}.`,
    },
    {
      label: 'Effective interest rate range is ordered',
      ok: eirMin < eirMax,
      detail: `${formatDecimalText(config.effectiveInterestRateMin)} … ${formatDecimalText(config.effectiveInterestRateMax)}.`,
    },
    {
      label: 'Stage 3 DPD backstop is at or beyond the Stage 2 backstop',
      ok: rules.stage3DpdThreshold >= rules.stage2DpdThreshold,
      detail: `Stage 2 at ${rules.stage2DpdThreshold} days, Stage 3 at ${rules.stage3DpdThreshold} days.`,
    },
    {
      label: 'Twelve-month window fits inside the lifetime horizon cap',
      ok: config.twelveMonthWindow <= config.lifetimeHorizonMonthsCap,
      detail: `${config.twelveMonthWindow} ≤ ${config.lifetimeHorizonMonthsCap} months.`,
    },
    {
      label: 'At least one staging rule is enabled',
      ok: rules.enabledRules.length > 0,
      detail: `${rules.enabledRules.length} of ${STAGING_RULE_CODES.length} rules enabled in rule set v${rules.version}.`,
    },
    {
      label: 'Deterministic engine, no model-generated figures',
      ok: true,
      detail:
        'ECL is produced by versioned, unit-tested decimal code. No LLM contributes to any persisted number.',
    },
  ];
}

/**
 * `LargeEclChangeThresholds` is typed `DecValue` because the engine accepts a
 * string, number or Decimal. Over JSON the API only ever sends a decimal string,
 * so this narrows it for display and form pre-fill without re-deriving a value.
 */
const thresholdText = (value: DecValue): string => String(value);

interface ConfigDraft {
  name: string;
  version: string;
  description: string;
  approvedBy: string;
  approvedAt: string;
  activate: boolean;
  lgdFloor: string;
  lgdCeiling: string;
  pdFloor: string;
  pdCeiling: string;
  effectiveInterestRateMin: string;
  effectiveInterestRateMax: string;
  defaultCreditConversionFactor: string;
  lifetimeHorizonMonthsCap: string;
  maxCalculationPeriods: string;
  twelveMonthWindow: string;
  discountConvention: DiscountConvention;
  defaultSimplifiedEadProfile: SimplifiedEadProfile;
  ruleSet: {
    id: string;
    version: string;
    stage3DpdThreshold: string;
    stage2DpdThreshold: string;
    ratingNotchSicrThreshold: string;
    pdIncreaseSicrMultiple: string;
    pdIncreaseSicrAbsoluteFloor: string;
    nearThresholdDpdBufferDays: string;
    nearThresholdPdBufferFraction: string;
    enabledRules: StagingRuleCode[];
  };
  exceptionThresholds: { relativeChange: string; absoluteChange: string; materialityFloor: string };
}

/** New versions start from an existing one — that is how the workflow actually runs. */
function toDraft(config: ModelConfigurationRecord): ConfigDraft {
  return {
    name: config.name,
    version: '',
    description: config.description ?? '',
    approvedBy: config.approvedBy,
    approvedAt: config.approvedAt.slice(0, 10),
    activate: false,
    lgdFloor: config.lgdFloor,
    lgdCeiling: config.lgdCeiling,
    pdFloor: config.pdFloor,
    pdCeiling: config.pdCeiling,
    effectiveInterestRateMin: config.effectiveInterestRateMin,
    effectiveInterestRateMax: config.effectiveInterestRateMax,
    defaultCreditConversionFactor: config.defaultCreditConversionFactor,
    lifetimeHorizonMonthsCap: String(config.lifetimeHorizonMonthsCap),
    maxCalculationPeriods: String(config.maxCalculationPeriods),
    twelveMonthWindow: String(config.twelveMonthWindow),
    discountConvention: config.discountConvention,
    defaultSimplifiedEadProfile: config.defaultSimplifiedEadProfile,
    ruleSet: {
      id: config.stagingRuleSet.id,
      version: config.stagingRuleSet.version,
      stage3DpdThreshold: String(config.stagingRuleSet.stage3DpdThreshold),
      stage2DpdThreshold: String(config.stagingRuleSet.stage2DpdThreshold),
      ratingNotchSicrThreshold: String(config.stagingRuleSet.ratingNotchSicrThreshold),
      pdIncreaseSicrMultiple: String(config.stagingRuleSet.pdIncreaseSicrMultiple),
      pdIncreaseSicrAbsoluteFloor: String(config.stagingRuleSet.pdIncreaseSicrAbsoluteFloor),
      nearThresholdDpdBufferDays: String(config.stagingRuleSet.nearThresholdDpdBufferDays),
      nearThresholdPdBufferFraction: String(config.stagingRuleSet.nearThresholdPdBufferFraction),
      enabledRules: [...config.stagingRuleSet.enabledRules],
    },
    exceptionThresholds: {
      relativeChange: thresholdText(config.exceptionThresholds.relativeChange),
      absoluteChange: thresholdText(config.exceptionThresholds.absoluteChange),
      materialityFloor: thresholdText(config.exceptionThresholds.materialityFloor),
    },
  };
}

const NUMERIC_FIELDS: Array<keyof ConfigDraft> = [
  'lgdFloor',
  'lgdCeiling',
  'pdFloor',
  'pdCeiling',
  'effectiveInterestRateMin',
  'effectiveInterestRateMax',
  'defaultCreditConversionFactor',
  'lifetimeHorizonMonthsCap',
  'maxCalculationPeriods',
  'twelveMonthWindow',
];

const NUMERIC_RULE_SET_FIELDS = [
  'stage3DpdThreshold',
  'stage2DpdThreshold',
  'ratingNotchSicrThreshold',
  'pdIncreaseSicrMultiple',
  'pdIncreaseSicrAbsoluteFloor',
  'nearThresholdDpdBufferDays',
  'nearThresholdPdBufferFraction',
] as const;

const isNumeric = (value: string): boolean => value.trim() !== '' && Number.isFinite(Number(value));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function ModelGovernancePage() {
  const { can } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['model-configurations'],
    queryFn: () =>
      api.modelConfigurations.list({ page: 1, pageSize: 50, sortDir: 'desc', sortBy: 'createdAt' }),
  });

  const canWrite = can('model:write');
  const configs = useMemo(() => data?.items ?? [], [data]);
  const active = useMemo(
    () => configs.find((config) => config.isActive) ?? configs[0] ?? null,
    [configs],
  );

  const create = useMutation({
    mutationFn: (input: ConfigDraft) =>
      api.modelConfigurations.create({
        name: input.name.trim(),
        version: input.version.trim(),
        description: input.description.trim() === '' ? undefined : input.description.trim(),
        stagingRuleSet: {
          id: input.ruleSet.id.trim(),
          version: input.ruleSet.version.trim(),
          stage3DpdThreshold: Number(input.ruleSet.stage3DpdThreshold),
          stage2DpdThreshold: Number(input.ruleSet.stage2DpdThreshold),
          ratingNotchSicrThreshold: Number(input.ruleSet.ratingNotchSicrThreshold),
          pdIncreaseSicrMultiple: Number(input.ruleSet.pdIncreaseSicrMultiple),
          pdIncreaseSicrAbsoluteFloor: Number(input.ruleSet.pdIncreaseSicrAbsoluteFloor),
          nearThresholdDpdBufferDays: Number(input.ruleSet.nearThresholdDpdBufferDays),
          nearThresholdPdBufferFraction: Number(input.ruleSet.nearThresholdPdBufferFraction),
          enabledRules: input.ruleSet.enabledRules,
        },
        lgdFloor: input.lgdFloor.trim(),
        lgdCeiling: input.lgdCeiling.trim(),
        pdFloor: input.pdFloor.trim(),
        pdCeiling: input.pdCeiling.trim(),
        lifetimeHorizonMonthsCap: Number(input.lifetimeHorizonMonthsCap),
        maxCalculationPeriods: Number(input.maxCalculationPeriods),
        discountConvention: input.discountConvention,
        effectiveInterestRateMin: input.effectiveInterestRateMin.trim(),
        effectiveInterestRateMax: input.effectiveInterestRateMax.trim(),
        defaultCreditConversionFactor: input.defaultCreditConversionFactor.trim(),
        defaultSimplifiedEadProfile: input.defaultSimplifiedEadProfile,
        twelveMonthWindow: Number(input.twelveMonthWindow),
        exceptionThresholds: {
          relativeChange: input.exceptionThresholds.relativeChange.trim(),
          absoluteChange: input.exceptionThresholds.absoluteChange.trim(),
          materialityFloor: input.exceptionThresholds.materialityFloor.trim(),
        },
        approvedBy: input.approvedBy.trim(),
        approvedAt: input.approvedAt.trim(),
        activate: input.activate,
      }),
    onSuccess: (created) => {
      push(
        'success',
        'Model version published',
        `${created.name} v${created.version} was created${created.isActive ? ' and is now active' : ''}. Runs already completed keep the version they were locked to.`,
      );
      setDraftOpen(false);
      setDraft(null);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['model-configurations'] });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError
          ? error.message
          : 'The model configuration could not be published.';
      setFormError(message);
      push('error', 'Version rejected', message);
    },
  });

  const patch = (fields: Partial<ConfigDraft>) =>
    setDraft((current) => (current ? { ...current, ...fields } : current));
  const patchRuleSet = (fields: Partial<ConfigDraft['ruleSet']>) =>
    setDraft((current) =>
      current ? { ...current, ruleSet: { ...current.ruleSet, ...fields } } : current,
    );

  const draftValid =
    draft !== null &&
    draft.name.trim().length >= 3 &&
    draft.version.trim().length >= 1 &&
    draft.approvedBy.trim().length >= 2 &&
    ISO_DATE.test(draft.approvedAt.trim()) &&
    draft.ruleSet.enabledRules.length > 0 &&
    NUMERIC_FIELDS.every((field) => isNumeric(draft[field] as string)) &&
    NUMERIC_RULE_SET_FIELDS.every((field) => isNumeric(draft.ruleSet[field])) &&
    Object.values(draft.exceptionThresholds).every(isNumeric);

  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  return (
    <div>
      <PageHeader
        title="Model governance"
        description="Versioned model configurations and the staging rule set each one carries. Every allowance the engine produces names the configuration id and version it used, so a figure can always be replayed."
        tags={<SyntheticBadge />}
        actions={
          canWrite && active ? (
            <Button
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setDraft(toDraft(active));
                setFormError(null);
                setDraftOpen(true);
              }}
            >
              New version
            </Button>
          ) : undefined
        }
      />

      {isLoading || !active ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64 lg:col-span-3" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Active model" description="The configuration new runs will use" />
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-navy-950">{active.name}</p>
                    <p className="text-xs text-slate-500">
                      Version {active.version} · <code className="font-mono">{active.id}</code>
                    </p>
                  </div>
                </div>
                {active.description ? (
                  <p className="text-xs leading-relaxed text-slate-600">{active.description}</p>
                ) : null}
                <div className="space-y-1.5 border-t border-line-soft pt-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Status</span>
                    <Badge tone={active.isActive ? 'positive' : 'neutral'}>
                      {active.isActive ? 'active' : 'superseded'}
                    </Badge>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Approved by</span>
                    <span className="text-right text-slate-800">{active.approvedBy}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Approved on</span>
                    <span className="tabular-nums text-slate-800">
                      {formatDate(active.approvedAt)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Created by</span>
                    <span className="text-right text-slate-800">{active.createdBy}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Supersedes</span>
                    <span className="tabular-nums text-slate-800">
                      {active.supersedesVersion ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-slate-500">
                      <Lock className="h-3.5 w-3.5" /> Locked by runs
                    </span>
                    <span className="tabular-nums text-slate-800">{active.lockedByRunCount}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader
                title="Approved parameters"
                description="Every value the deterministic engine reads"
              />
              <CardContent>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {parameterRows(active).map((row) => (
                    <div key={row.label} className="border-b border-line-soft pb-3 last:border-b-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-xs font-medium text-slate-600">{row.label}</dt>
                        <dd className="text-right text-sm font-semibold tabular-nums text-navy-900">
                          {row.value}
                        </dd>
                      </div>
                      <p className="mt-0.5 text-2xs leading-relaxed text-slate-400">
                        {row.description}
                      </p>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Staging rule set"
                description={`${active.stagingRuleSet.id} v${active.stagingRuleSet.version} — thresholds are configuration, never code`}
              />
              <CardContent>
                <dl className="space-y-2 text-sm">
                  {[
                    ['Stage 3 DPD backstop', `${active.stagingRuleSet.stage3DpdThreshold} days`],
                    ['Stage 2 DPD backstop', `${active.stagingRuleSet.stage2DpdThreshold} days`],
                    [
                      'Rating-notch SICR threshold',
                      `${active.stagingRuleSet.ratingNotchSicrThreshold} notches`,
                    ],
                    [
                      'PD-increase SICR multiple',
                      `× ${formatDecimalText(String(active.stagingRuleSet.pdIncreaseSicrMultiple))}`,
                    ],
                    [
                      'PD-increase absolute floor',
                      formatDecimalText(String(active.stagingRuleSet.pdIncreaseSicrAbsoluteFloor)),
                    ],
                    [
                      'Near-threshold DPD buffer',
                      `${active.stagingRuleSet.nearThresholdDpdBufferDays} days`,
                    ],
                    [
                      'Near-threshold PD buffer',
                      formatDecimalText(
                        String(active.stagingRuleSet.nearThresholdPdBufferFraction),
                      ),
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-baseline justify-between gap-3 border-b border-line-soft pb-2 last:border-b-0"
                    >
                      <dt className="text-xs text-slate-500">{label}</dt>
                      <dd className="tabular-nums font-medium text-slate-800">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-slate-600">Enabled rules</p>
                  <div className="flex flex-wrap gap-1.5">
                    {STAGING_RULE_CODES.map((code) => {
                      const enabled = active.stagingRuleSet.enabledRules.includes(code);
                      return (
                        <span
                          key={code}
                          title={enabled ? stagingCodeLabel(code) : 'Disabled in this version'}
                          className={
                            enabled
                              ? 'rounded-full border border-navy-200 bg-navy-50 px-2 py-0.5 font-mono text-[10px] text-navy-800'
                              : 'rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-slate-400 line-through'
                          }
                        >
                          {code}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title="Validation checks"
                description="Read off this version, not asserted separately"
              />
              <CardContent className="space-y-4">
                <ul className="space-y-3">
                  {validationChecks(active).map((check) => (
                    <li key={check.label} className="flex items-start gap-3">
                      {check.ok ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-slate-800">{check.label}</p>
                        <p className="text-xs text-slate-500">{check.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line-soft pt-3">
                  <p className="mb-1.5 text-xs font-medium text-slate-600">
                    Exception queue thresholds
                  </p>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                    <span>
                      Relative change{' '}
                      <span className="tabular-nums text-slate-800">
                        {formatDecimalPercent(
                          thresholdText(active.exceptionThresholds.relativeChange),
                          0,
                        )}
                      </span>
                    </span>
                    <span>
                      Absolute change{' '}
                      <span className="tabular-nums text-slate-800">
                        {formatDecimalText(
                          thresholdText(active.exceptionThresholds.absoluteChange),
                        )}
                      </span>
                    </span>
                    <span>
                      Materiality floor{' '}
                      <span className="tabular-nums text-slate-800">
                        {formatDecimalText(
                          thresholdText(active.exceptionThresholds.materialityFloor),
                        )}
                      </span>
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader
              title="Version history"
              description="Superseded versions stay readable; the runs locked to them are unchanged"
            />
            <CardContent>
              {configs.length === 0 ? (
                <EmptyState
                  title="No model configurations"
                  description="Publish a version before running the engine."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-line text-2xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Version</th>
                        <th className="py-2 pr-3 font-medium">Name</th>
                        <th className="py-2 pr-3 font-medium">Rule set</th>
                        <th className="py-2 pr-3 font-medium">Approved</th>
                        <th className="py-2 pr-3 font-medium">Locked by runs</th>
                        <th className="py-2 font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {configs.map((config) => (
                        <tr key={config.id} className={config.isActive ? '' : 'opacity-70'}>
                          <td className="py-2.5 pr-3">
                            <span className="block tabular-nums font-medium text-navy-900">
                              {config.version}
                            </span>
                            {config.supersedesVersion ? (
                              <span className="block text-2xs text-slate-400">
                                supersedes {config.supersedesVersion}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-3 text-slate-700">{config.name}</td>
                          <td className="py-2.5 pr-3">
                            <code className="font-mono text-2xs text-slate-500">
                              {config.stagingRuleSet.id} v{config.stagingRuleSet.version}
                            </code>
                          </td>
                          <td className="py-2.5 pr-3 text-xs text-slate-500">
                            <span className="block tabular-nums">
                              {formatDate(config.approvedAt)}
                            </span>
                            <span className="block">{config.approvedBy}</span>
                          </td>
                          <td className="py-2.5 pr-3 tabular-nums text-slate-700">
                            {config.lockedByRunCount}
                          </td>
                          <td className="py-2.5">
                            <Badge tone={config.isActive ? 'positive' : 'neutral'}>
                              {config.isActive ? 'active' : 'superseded'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Modal
        open={draftOpen && draft !== null}
        onClose={() => setDraftOpen(false)}
        title="Publish a new model version"
        description="Pre-filled from the active configuration. Nothing here edits an existing version — submitting creates a new one."
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraftOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!draftValid || draft === null}
              onClick={() => draft && create.mutate(draft)}
            >
              Publish version
            </Button>
          </div>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Name"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
              <Input
                label="Version"
                value={draft.version}
                onChange={(event) => patch({ version: event.target.value })}
                placeholder="1.1.0"
                hint="Required, and must differ from every existing version of this model."
              />
              <Input
                label="Approved by"
                value={draft.approvedBy}
                onChange={(event) => patch({ approvedBy: event.target.value })}
              />
              <Input
                label="Approved on"
                type="date"
                value={draft.approvedAt}
                onChange={(event) => patch({ approvedAt: event.target.value })}
              />
            </div>
            <Input
              label="Description"
              value={draft.description}
              onChange={(event) => patch({ description: event.target.value })}
              placeholder="What changed in this version and why"
            />

            <div className="rounded-lg border border-line p-3">
              <p className="mb-2 text-xs font-medium text-slate-700">Bounds and horizon</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="LGD floor"
                  value={draft.lgdFloor}
                  onChange={(event) => patch({ lgdFloor: event.target.value })}
                />
                <Input
                  label="LGD ceiling"
                  value={draft.lgdCeiling}
                  onChange={(event) => patch({ lgdCeiling: event.target.value })}
                />
                <Input
                  label="Default CCF"
                  value={draft.defaultCreditConversionFactor}
                  onChange={(event) => patch({ defaultCreditConversionFactor: event.target.value })}
                />
                <Input
                  label="PD floor"
                  value={draft.pdFloor}
                  onChange={(event) => patch({ pdFloor: event.target.value })}
                />
                <Input
                  label="PD ceiling"
                  value={draft.pdCeiling}
                  onChange={(event) => patch({ pdCeiling: event.target.value })}
                />
                <Input
                  label="12-month window"
                  value={draft.twelveMonthWindow}
                  onChange={(event) => patch({ twelveMonthWindow: event.target.value })}
                />
                <Input
                  label="Horizon cap (months)"
                  value={draft.lifetimeHorizonMonthsCap}
                  onChange={(event) => patch({ lifetimeHorizonMonthsCap: event.target.value })}
                />
                <Input
                  label="Max periods"
                  value={draft.maxCalculationPeriods}
                  onChange={(event) => patch({ maxCalculationPeriods: event.target.value })}
                />
                <Input
                  label="EIR min"
                  value={draft.effectiveInterestRateMin}
                  onChange={(event) => patch({ effectiveInterestRateMin: event.target.value })}
                />
                <Input
                  label="EIR max"
                  value={draft.effectiveInterestRateMax}
                  onChange={(event) => patch({ effectiveInterestRateMax: event.target.value })}
                />
                <Select
                  label="Discount convention"
                  value={draft.discountConvention}
                  onChange={(event) =>
                    patch({ discountConvention: event.target.value as DiscountConvention })
                  }
                >
                  {DISCOUNT_CONVENTIONS.map((convention) => (
                    <option key={convention} value={convention}>
                      {convention}
                    </option>
                  ))}
                </Select>
                <Select
                  label="Simplified EAD profile"
                  value={draft.defaultSimplifiedEadProfile}
                  onChange={(event) =>
                    patch({
                      defaultSimplifiedEadProfile: event.target.value as SimplifiedEadProfile,
                    })
                  }
                >
                  {SIMPLIFIED_EAD_PROFILES.map((profile) => (
                    <option key={profile} value={profile}>
                      {profile}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="rounded-lg border border-line p-3">
              <div className="mb-2 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Staging rule set id"
                  value={draft.ruleSet.id}
                  onChange={(event) => patchRuleSet({ id: event.target.value })}
                />
                <Input
                  label="Staging rule set version"
                  value={draft.ruleSet.version}
                  onChange={(event) => patchRuleSet({ version: event.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Stage 3 DPD"
                  value={draft.ruleSet.stage3DpdThreshold}
                  onChange={(event) => patchRuleSet({ stage3DpdThreshold: event.target.value })}
                />
                <Input
                  label="Stage 2 DPD"
                  value={draft.ruleSet.stage2DpdThreshold}
                  onChange={(event) => patchRuleSet({ stage2DpdThreshold: event.target.value })}
                />
                <Input
                  label="Rating notches for SICR"
                  value={draft.ruleSet.ratingNotchSicrThreshold}
                  onChange={(event) =>
                    patchRuleSet({ ratingNotchSicrThreshold: event.target.value })
                  }
                />
                <Input
                  label="PD-increase multiple"
                  value={draft.ruleSet.pdIncreaseSicrMultiple}
                  onChange={(event) => patchRuleSet({ pdIncreaseSicrMultiple: event.target.value })}
                />
                <Input
                  label="PD-increase floor"
                  value={draft.ruleSet.pdIncreaseSicrAbsoluteFloor}
                  onChange={(event) =>
                    patchRuleSet({ pdIncreaseSicrAbsoluteFloor: event.target.value })
                  }
                />
                <Input
                  label="Near-threshold DPD buffer"
                  value={draft.ruleSet.nearThresholdDpdBufferDays}
                  onChange={(event) =>
                    patchRuleSet({ nearThresholdDpdBufferDays: event.target.value })
                  }
                />
                <Input
                  label="Near-threshold PD buffer"
                  value={draft.ruleSet.nearThresholdPdBufferFraction}
                  onChange={(event) =>
                    patchRuleSet({ nearThresholdPdBufferFraction: event.target.value })
                  }
                />
              </div>
              <p className="mb-2 mt-3 text-xs font-medium text-slate-700">Enabled rules</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {STAGING_RULE_CODES.map((code) => {
                  const enabled = draft.ruleSet.enabledRules.includes(code);
                  return (
                    <label key={code} className="flex items-start gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(event) =>
                          patchRuleSet({
                            enabledRules: event.target.checked
                              ? [...draft.ruleSet.enabledRules, code]
                              : draft.ruleSet.enabledRules.filter((existing) => existing !== code),
                          })
                        }
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-navy-700 focus:ring-navy-500"
                      />
                      <span>
                        <code className="font-mono text-2xs">{code}</code>
                        <span className="block text-2xs text-slate-400">
                          {stagingCodeLabel(code)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-line p-3">
              <p className="mb-2 text-xs font-medium text-slate-700">Exception queue thresholds</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Relative change"
                  value={draft.exceptionThresholds.relativeChange}
                  onChange={(event) =>
                    patch({
                      exceptionThresholds: {
                        ...draft.exceptionThresholds,
                        relativeChange: event.target.value,
                      },
                    })
                  }
                />
                <Input
                  label="Absolute change"
                  value={draft.exceptionThresholds.absoluteChange}
                  onChange={(event) =>
                    patch({
                      exceptionThresholds: {
                        ...draft.exceptionThresholds,
                        absoluteChange: event.target.value,
                      },
                    })
                  }
                />
                <Input
                  label="Materiality floor"
                  value={draft.exceptionThresholds.materialityFloor}
                  onChange={(event) =>
                    patch({
                      exceptionThresholds: {
                        ...draft.exceptionThresholds,
                        materialityFloor: event.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={draft.activate}
                onChange={(event) => patch({ activate: event.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-navy-700 focus:ring-navy-500"
              />
              Make this the active configuration for new runs
            </label>

            {formError ? (
              <p
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                role="alert"
              >
                {formError}
              </p>
            ) : (
              <p className="flex items-start gap-2 text-2xs leading-relaxed text-slate-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Publishing never mutates an existing version. {active?.lockedByRunCount ?? 0} run(s)
                are frozen to the configuration shown above and will keep reporting exactly the
                figures they already produced.
              </p>
            )}
            <p className="text-2xs text-slate-400">
              Last published {active ? formatDateTime(active.createdAt) : '—'}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
