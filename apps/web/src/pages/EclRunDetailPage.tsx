/**
 * Run detail: the workflow screen and the top of the drill-down
 * (implementation task 7, acceptance criteria 2 and 4).
 *
 * Everything the run was locked to is rendered from the run record itself —
 * snapshot, model configuration version, scenario set version, readiness checks,
 * lineage — so a reviewer can see what produced the number without opening three
 * other screens. An approved run is locked, and the page says so instead of
 * offering buttons that would 409.
 *
 * The four-eyes rule is enforced server-side against the *creator*: the API
 * answers `RUN_SELF_APPROVAL_PROHIBITED` rather than hiding the button, because
 * hiding it would not tell a reviewer why they cannot act. The rejection message
 * is surfaced verbatim.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileDown,
  Lock,
  Play,
  RefreshCw,
  SearchX,
  Send,
  XCircle,
} from 'lucide-react';
import type { RunResultRowRecord, RunStatus, Stage } from '@eclens/shared';
import { formatDate, formatDateTime, formatDecimalPercent, formatDecimalText, formatVersionedRef } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError, saveBase64File } from '@/api/http';
import { ExecutiveCommentaryPanel } from '@/components/ai/ExecutiveCommentaryPanel';
import { RunResultDrawer } from '@/components/runs/RunResultDrawer';
import { Badge, StageBadge, type BadgeTone, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useServerList } from '@/hooks/useServerList';
import { stagingCodeLabel } from '@/lib/staging';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';

const column = createColumnHelper<RunResultRowRecord>();

const STATUS_TONE: Record<RunStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PENDING: 'info',
  RUNNING: 'info',
  COMPLETED: 'positive',
  FAILED: 'danger',
  SUBMITTED: 'warning',
  APPROVED: 'positive',
  REJECTED: 'danger',
};

/** Mirrors the service's `RUN_STATUSES_ALLOWED_TO_EXECUTE`. */
const EXECUTABLE: RunStatus[] = ['DRAFT', 'FAILED', 'REJECTED', 'COMPLETED'];
const IN_FLIGHT: RunStatus[] = ['PENDING', 'RUNNING'];

const REVIEW_COMMENT_MIN = 3;

type ReviewAction = 'submit' | 'approve' | 'reject';

const REVIEW_COPY: Record<ReviewAction, { title: string; label: string; confirm: string; tone: 'primary' | 'danger' }> =
  {
    submit: {
      title: 'Submit for review',
      label: 'An optional note for the reviewer',
      confirm: 'Submit for review',
      tone: 'primary',
    },
    approve: {
      title: 'Approve and lock this run',
      label: 'Review comment (required, at least 3 characters)',
      confirm: 'Approve and lock',
      tone: 'primary',
    },
    reject: {
      title: 'Reject this run',
      label: 'Review comment (required, at least 3 characters)',
      confirm: 'Reject',
      tone: 'danger',
    },
  };

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-xs text-slate-800">{value}</dd>
    </div>
  );
}

export function EclRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { can, user } = useAuth();
  const { moneyString, percentString } = useSettings();

  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [comment, setComment] = useState('');
  const [openExposureId, setOpenExposureId] = useState<string | null>(null);

  const results = useServerList<{ stage?: Stage }>({}, { sortBy: 'lossAllowance', sortDir: 'desc', pageSize: 25 });

  const { data: run, isLoading, isError, refetch } = useQuery({
    queryKey: ['ecl-run', runId],
    queryFn: () => api.runs.get(runId ?? ''),
    enabled: runId !== undefined,
    refetchInterval: (query) => (IN_FLIGHT.includes(query.state.data?.status ?? 'DRAFT') ? 1500 : false),
  });

  const hasResults = run?.totals !== null && run?.totals !== undefined;

  const resultsQuery = useQuery({
    queryKey: ['ecl-run-results', runId, results.query],
    queryFn: () => api.runs.results(runId ?? '', results.query),
    enabled: runId !== undefined && hasResults,
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['ecl-run', runId] });
    void queryClient.invalidateQueries({ queryKey: ['ecl-run-results', runId] });
    void queryClient.invalidateQueries({ queryKey: ['ecl-runs'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['exceptions'] });
  };

  const execute = useMutation({
    mutationFn: () => api.runs.execute(runId ?? ''),
    onSuccess: (accepted) => {
      push(
        'success',
        'Execution started',
        `Job ${accepted.jobId} on the ${accepted.driver} driver. This panel polls until the run completes.`,
      );
      refreshAll();
    },
    onError: (error) => push('error', 'Execution rejected', messageOf(error, 'The run could not be started.')),
  });

  const report = useMutation({
    mutationFn: () => api.runs.report(runId ?? ''),
    onSuccess: (download) => {
      saveBase64File(download.fileName, download.contentBase64, download.contentType);
      push('success', 'Report downloaded', download.fileName);
    },
    onError: (error) => push('error', 'Report generation failed', messageOf(error, 'The report could not be generated.')),
  });

  const review = useMutation({
    mutationFn: (action: ReviewAction) => {
      const id = runId ?? '';
      const text = comment.trim();
      if (action === 'submit') return api.runs.submit(id, text === '' ? undefined : text);
      if (action === 'approve') return api.runs.approve(id, text);
      return api.runs.reject(id, text);
    },
    onSuccess: (updated, action) => {
      setReviewAction(null);
      setComment('');
      push(
        action === 'reject' ? 'info' : 'success',
        action === 'submit'
          ? `Run ${updated.publicId} submitted`
          : action === 'approve'
            ? `Run ${updated.publicId} approved and locked`
            : `Run ${updated.publicId} rejected`,
        action === 'approve'
          ? 'The results and the configuration versions are now frozen.'
          : action === 'reject'
            ? 'The run can be corrected and executed again.'
            : 'A reviewer other than the creator must now decide.',
      );
      refreshAll();
    },
    onError: (error) => {
      // The four-eyes guard is a policy answer, not a failure to parse: show it as
      // the API phrased it so the reviewer knows exactly which rule stopped them.
      push('error', 'Review rejected', messageOf(error, 'The review action could not be completed.'));
    },
  });

  if (isError) return <ErrorState title="The run could not be loaded" onRetry={() => void refetch()} />;

  if (isLoading || !run) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const totals = run.totals;
  const locked = run.status === 'APPROVED';
  const canExecute = can('run:execute') && EXECUTABLE.includes(run.status) && run.readiness.ready;
  const canSubmit = can('run:submit') && run.status === 'COMPLETED' && totals !== null;
  const canReview = can('run:review') && run.status === 'SUBMITTED';
  const isCreator = run.createdById !== null && user?.id === run.createdById;
  const failedChecks = run.readiness.checks.filter((check) => !check.ok);

  const resultColumns = [
    column.accessor('exposurePublicId', {
      header: 'Exposure',
      enableSorting: false,
      cell: (info) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-navy-800">{info.row.original.borrowerName}</p>
          <p className="text-[10px] text-slate-400">
            <code>{info.getValue()}</code> · {info.row.original.segment}
          </p>
        </div>
      ),
    }),
    column.accessor('stage', {
      header: 'Stage',
      cell: (info) => <StageBadge stage={info.getValue()} />,
    }),
    column.accessor('stagePrimaryReason', {
      header: 'Primary reason',
      enableSorting: false,
      cell: (info) => (
        <span className="text-xs text-slate-500" title={info.row.original.stagePrimaryReason}>
          {stagingCodeLabel(info.getValue())}
        </span>
      ),
    }),
    column.accessor('horizonMonths', {
      header: 'Horizon',
      cell: (info) => <span className="tabular-nums text-slate-600">{info.getValue()}m</span>,
    }),
    column.accessor('grossCarryingAmount', {
      header: 'Gross',
      cell: (info) => <span className="tabular-nums">{moneyString(info.getValue(), { compact: true })}</span>,
    }),
    column.accessor('ead', {
      header: 'EAD',
      enableSorting: false,
      cell: (info) => (
        <span className="tabular-nums text-slate-600">{moneyString(info.getValue(), { compact: true })}</span>
      ),
    }),
    column.accessor('pd', {
      header: 'PD',
      enableSorting: false,
      cell: (info) => <span className="tabular-nums">{formatDecimalPercent(info.getValue(), 3)}</span>,
    }),
    column.accessor('lgd', {
      header: 'LGD',
      enableSorting: false,
      cell: (info) => <span className="tabular-nums">{formatDecimalPercent(info.getValue(), 1)}</span>,
    }),
    column.accessor('lossAllowance', {
      header: 'Loss allowance',
      cell: (info) => (
        <span className="font-medium tabular-nums text-red-700">{moneyString(info.getValue())}</span>
      ),
    }),
    column.accessor('coverageRatio', {
      header: 'Coverage',
      cell: (info) => <span className="tabular-nums text-slate-600">{percentString(info.getValue())}</span>,
    }),
    column.accessor('changeVsPreviousRun', {
      header: 'Δ vs previous',
      enableSorting: false,
      cell: (info) => {
        const value = info.getValue();
        if (value === null) return <span className="text-slate-300">—</span>;
        const negative = value.startsWith('-');
        return (
          <span className={`tabular-nums ${negative ? 'text-emerald-700' : 'text-red-700'}`}>
            {moneyString(value, { compact: true })}
          </span>
        );
      },
    }),
  ];

  const reviewCopy = reviewAction ? REVIEW_COPY[reviewAction] : null;
  const reviewValid =
    reviewAction !== null &&
    (reviewAction === 'submit' || comment.trim().length >= REVIEW_COMMENT_MIN);

  return (
    <div>
      <Link
        to="/ecl-runs"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-navy-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to runs
      </Link>

      <PageHeader
        title={`Run ${run.publicId}`}
        description={`${run.snapshotLabel} · reporting date ${formatDate(run.runDate)} · created by ${run.createdByName}`}
        tags={
          <>
            <Badge tone={STATUS_TONE[run.status]}>{run.status.toLowerCase()}</Badge>
            {locked ? (
              <Badge tone="info">
                <Lock className="mr-1 inline h-3 w-3" />
                locked
              </Badge>
            ) : null}
            <SyntheticBadge />
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void refetch()}
            >
              Refresh
            </Button>
            {can('report:export') && hasResults ? (
              <Button
                data-tour="tour-run-report"
                variant="secondary"
                size="sm"
                icon={<FileDown className="h-3.5 w-3.5" />}
                loading={report.isPending}
                onClick={() => report.mutate()}
              >
                Generate report
              </Button>
            ) : null}
            {can('run:execute') ? (
              <Button
                size="sm"
                icon={<Play className="h-3.5 w-3.5" />}
                loading={execute.isPending}
                disabled={!canExecute}
                onClick={() => execute.mutate()}
              >
                Execute
              </Button>
            ) : null}
            {canSubmit ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Send className="h-3.5 w-3.5" />}
                onClick={() => setReviewAction('submit')}
              >
                Submit for review
              </Button>
            ) : null}
            {canReview ? (
              <>
                <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setReviewAction('approve')}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<XCircle className="h-3.5 w-3.5" />}
                  onClick={() => setReviewAction('reject')}
                >
                  Reject
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {run.error ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="font-semibold">This run failed.</strong> {run.error}
          </span>
        </p>
      ) : null}

      {IN_FLIGHT.includes(run.status) ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-navy-200 bg-navy-50 px-4 py-3 text-sm text-navy-800">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
          {run.status === 'PENDING' ? 'Queued for execution…' : 'Calculating…'} This page polls the run until it
          settles.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total loss allowance"
          value={totals ? moneyString(totals.totalLossAllowance) : '—'}
          hint={totals ? `${totals.exposureCount} exposure(s) · scenario-weighted` : 'No results yet'}
          loading={isLoading}
        />
        <MetricCard
          label="Coverage ratio"
          value={totals ? percentString(totals.coverageRatio, 4) : '—'}
          hint="Allowance / gross carrying amount"
        />
        <MetricCard
          label="Gross carrying amount"
          value={totals ? moneyString(totals.totalGrossCarryingAmount, { compact: true }) : '—'}
          hint="Before the loss allowance"
        />
        <MetricCard
          label="Total EAD"
          value={totals ? moneyString(totals.totalEad, { compact: true }) : '—'}
          hint="Drawn plus CCF × undrawn, summed over periods"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Run parameters" description="Locked when the run was created" />
          <CardContent>
            <dl>
              <Fact label="Snapshot" value={`${run.snapshotLabel} · ${run.snapshotId.slice(0, 12)}…`} />
              <Fact
                label="Model configuration"
                value={
                  <span>
                    {run.modelConfigurationName} <code>v{run.modelConfigurationVersion}</code>
                  </span>
                }
              />
              <Fact
                label="Scenario set"
                value={
                  <span>
                    {run.scenarioSetName} <code>v{run.scenarioSetVersion}</code>
                  </span>
                }
              />
              <Fact label="Created by" value={run.createdByName} />
              <Fact
                label="Started"
                value={run.startedAt ? formatDateTime(run.startedAt) : <span className="text-slate-400">not run</span>}
              />
              <Fact
                label="Completed"
                value={
                  run.completedAt ? formatDateTime(run.completedAt) : <span className="text-slate-400">not run</span>
                }
              />
              <Fact
                label="Duration"
                value={run.durationMs !== null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}
              />
              {run.notes ? <Fact label="Notes" value={run.notes} /> : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Readiness" description="Checked again before every execution" />
          <CardContent className="space-y-3">
            <ul className="space-y-1.5">
              {run.readiness.checks.map((check) => (
                <li key={check.code} className="flex items-start gap-2 text-xs">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                  )}
                  <span>
                    <span className="font-medium text-slate-800">{check.code}</span>
                    <span className="block text-slate-500">{check.message}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-slate-100 pt-2 text-[11px] text-slate-500">
              {run.readiness.ready
                ? 'All checks pass — execution is allowed.'
                : `${failedChecks.length} check(s) failed — the API will answer 409 RUN_NOT_READY.`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Scenario weights" description="Frozen with the run, not read live" />
          <CardContent className="space-y-3">
            {Object.keys(run.scenarioWeights).length === 0 ? (
              <p className="text-xs text-slate-500">
                No weights are stored yet — they are captured when the run executes.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {Object.entries(run.scenarioWeights).map(([code, weight]) => (
                  <li key={code} className="flex items-center justify-between text-xs">
                    <span className="text-slate-700">{code}</span>
                    <span className="tabular-nums text-slate-600">
                      <span className="font-mono text-[11px]">{formatDecimalText(weight)}</span>{' '}
                      <span className="text-slate-400">({formatDecimalPercent(weight, 1)})</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {totals ? (
              <p className="border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-500">
                {totals.roundingPolicy}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Stage buckets" description="Allowance and net carrying amount by IFRS 9 stage" />
          <CardContent>
            {totals ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Stage</th>
                      <th className="px-2 py-1.5 text-right font-medium">Exposures</th>
                      <th className="px-2 py-1.5 text-right font-medium">Gross</th>
                      <th className="px-2 py-1.5 text-right font-medium">Allowance</th>
                      <th className="px-2 py-1.5 text-right font-medium">Net</th>
                      <th className="px-2 py-1.5 text-right font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {totals.stageBuckets.map((bucket) => (
                      <tr key={bucket.stage}>
                        <td className="px-2 py-1.5">
                          <StageBadge stage={bucket.stage} />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{bucket.exposureCount}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {moneyString(bucket.grossCarryingAmount, { compact: true })}
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums text-red-700">
                          {moneyString(bucket.lossAllowance, { compact: true })}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {moneyString(bucket.netCarryingAmount, { compact: true })}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                          {percentString(bucket.coverageRatio)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No totals — this run has not produced results.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Review trail" description="Four-eyes: the creator cannot approve or reject their own run" />
          <CardContent>
            <dl>
              <Fact
                label="Submitted"
                value={
                  run.submittedAt
                    ? `${run.submittedByName ?? '—'} · ${formatDateTime(run.submittedAt)}`
                    : <span className="text-slate-400">not submitted</span>
                }
              />
              <Fact
                label="Decision"
                value={
                  run.reviewDecision ? (
                    <Badge tone={run.reviewDecision === 'APPROVED' ? 'positive' : 'danger'}>
                      {run.reviewDecision.toLowerCase()}
                    </Badge>
                  ) : (
                    <span className="text-slate-400">pending</span>
                  )
                }
              />
              <Fact
                label="Reviewed"
                value={
                  run.reviewedAt
                    ? `${run.reviewedByName ?? '—'} · ${formatDateTime(run.reviewedAt)}`
                    : <span className="text-slate-400">—</span>
                }
              />
              {run.reviewComment ? <Fact label="Comment" value={run.reviewComment} /> : null}
              <Fact
                label="Locked at"
                value={run.lockedAt ? formatDateTime(run.lockedAt) : <span className="text-slate-400">not locked</span>}
              />
            </dl>
            {locked && run.lockedConfiguration ? (
              <p className="mt-2 flex items-start gap-2 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-[11px] leading-relaxed text-navy-800">
                <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                Frozen model configuration{' '}
                <code>
                  {formatVersionedRef(
                    run.modelConfigurationName,
                    run.modelConfigurationId,
                    run.lockedConfiguration.version,
                  )}
                </code>{' '}
                and scenario set{' '}
                <code>
                  {formatVersionedRef(
                    run.lockedScenarioSet?.name ?? run.scenarioSetName,
                    run.scenarioSetId,
                    run.lockedScenarioSet?.version ?? run.scenarioSetVersion,
                  )}
                </code>{' '}
                are stored on the run. Editing the active versions now cannot change these results.
              </p>
            ) : null}
            {isCreator && canReview ? (
              <p className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                You created this run, so the API will refuse your approval or rejection with{' '}
                <code>RUN_SELF_{reviewAction === 'reject' ? 'REJECTION' : 'APPROVAL'}_PROHIBITED</code>. Another
                reviewer must decide.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {run.lineage ? (
        <Card className="mt-4">
          <CardHeader title="Lineage" description="Every input version, the reporting date, the actor and the timestamp" />
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Input version</dt>
                <dd className="mt-0.5 text-xs">
                  <code>{run.lineage.inputVersion}</code>
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Model configuration
                </dt>
                <dd className="mt-0.5 text-xs">
                  {formatVersionedRef(
                    run.lineage.modelConfigurationName,
                    run.lineage.modelConfigurationId,
                    run.lineage.modelConfigurationVersion,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Staging rule set</dt>
                <dd className="mt-0.5 text-xs">
                  <code>
                    {run.lineage.stagingRuleSetId} v{run.lineage.stagingRuleSetVersion}
                  </code>
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Scenario set</dt>
                <dd className="mt-0.5 text-xs">
                  {formatVersionedRef(
                    run.lineage.scenarioSetName,
                    run.lineage.scenarioSetId,
                    run.lineage.scenarioSetVersion,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Reporting date</dt>
                <dd className="mt-0.5 text-xs tabular-nums">{formatDate(run.lineage.reportingDate)}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Calculated at</dt>
                <dd className="mt-0.5 text-xs tabular-nums">{formatDateTime(run.lineage.calculatedAt)}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Actor</dt>
                <dd className="mt-0.5 text-xs">
                  {run.lineage.actorName} <span className="text-slate-400">({run.lineage.actorId})</span>
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Rounding</dt>
                <dd className="mt-0.5 text-xs text-slate-600">{run.lineage.roundingPolicy}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader
          title="Per-exposure results"
          description={
            resultsQuery.data
              ? `${resultsQuery.data.meta.totalItems} exposure(s). Select a row for period-level PD, LGD, EAD, discount factor and the formula trace.`
              : 'Select a row for period-level PD, LGD, EAD, discount factor and the formula trace.'
          }
          actions={
            <div className="flex w-80 items-center gap-2">
              <Input
                aria-label="Search results"
                placeholder="Search borrower or exposure id…"
                value={results.searchInput}
                onChange={(event) => results.setSearchInput(event.target.value)}
              />
              <Select
                aria-label="Filter by stage"
                className="w-32"
                value={results.filters.stage ?? ''}
                onChange={(event) =>
                  results.setFilter('stage', event.target.value === '' ? undefined : (Number(event.target.value) as Stage))
                }
              >
                <option value="">All stages</option>
                <option value="1">Stage 1</option>
                <option value="2">Stage 2</option>
                <option value="3">Stage 3</option>
              </Select>
            </div>
          }
        />
        {!hasResults ? (
          <EmptyState
            icon={<SearchX className="h-8 w-8" />}
            title="No results stored for this run"
            description={
              run.status === 'FAILED'
                ? 'The run failed before producing results. The failure note is above.'
                : 'Execute the run to compute and persist the per-exposure results.'
            }
          />
        ) : resultsQuery.isError ? (
          <ErrorState title="The results could not be loaded" onRetry={() => void resultsQuery.refetch()} />
        ) : (
          <>
            <DataTable
              columns={resultColumns}
              data={resultsQuery.data?.items ?? []}
              loading={resultsQuery.isLoading}
              getRowId={(row) => row.id}
              onRowClick={(row) => setOpenExposureId(row.exposurePublicId)}
              manualSorting
              sorting={results.sortingState}
              onSortingChange={results.applySorting}
              emptyTitle="No rows match those filters"
              emptyDescription="Clear the stage filter or the search term to see the whole result set."
            />
            {resultsQuery.data ? (
              <Pagination
                meta={resultsQuery.data.meta}
                onPageChange={results.setPage}
                loading={resultsQuery.isFetching}
              />
            ) : null}
          </>
        )}
      </Card>

      {totals ? (
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          The portfolio total is the exact sum of the per-exposure allowances, and each exposure allowance is the exact
          sum of its rounded scenario contributions — so this table adds up to{' '}
          <span className="font-medium text-slate-700">{moneyString(totals.totalLossAllowance)}</span> with no
          unexplained residual. Per-row EAD is rounded to 2 decimals before it is summed, so the total EAD can differ
          from a hand-summed column by at most half a rupee per exposure.
        </p>
      ) : null}

      {/*
        Below the results table, not above it. The commentary is a draft a
        reviewer writes *after* checking the numbers, and putting it first would
        invite them to circulate a narrative before they had opened the table it
        summarises. Offered only once totals exist — a run that produced no
        results has nothing for the model to cite.
      */}
      {can('ai:use') && totals ? (
        <div className="mt-4">
          <ExecutiveCommentaryPanel runId={run.publicId} runLabel={run.publicId} />
        </div>
      ) : null}

      <RunResultDrawer
        runId={run.publicId}
        exposurePublicId={openExposureId}
        onClose={() => setOpenExposureId(null)}
      />

      <Modal
        open={reviewAction !== null}
        onClose={() => {
          setReviewAction(null);
          setComment('');
        }}
        title={reviewCopy?.title ?? ''}
        description={
          reviewAction === 'approve'
            ? 'Approving locks the run: its results, configuration version and scenario set version become immutable.'
            : reviewAction === 'reject'
              ? 'Rejecting returns the run to the creator, who can correct it and execute again.'
              : 'Submitting hands the run to a reviewer. You will not be able to approve it yourself.'
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setReviewAction(null);
                setComment('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant={reviewCopy?.tone === 'danger' ? 'danger' : 'primary'}
              loading={review.isPending}
              disabled={!reviewValid}
              onClick={() => reviewAction && review.mutate(reviewAction)}
            >
              {reviewCopy?.confirm ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <Input
          label={reviewCopy?.label ?? ''}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          error={
            reviewAction !== null && reviewAction !== 'submit' && comment.trim().length < REVIEW_COMMENT_MIN
              ? `At least ${REVIEW_COMMENT_MIN} characters are required for the audit trail.`
              : undefined
          }
        />
      </Modal>
    </div>
  );
}
