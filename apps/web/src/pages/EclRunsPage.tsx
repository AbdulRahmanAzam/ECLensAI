/**
 * ECL run list and run creation (implementation tasks 7 and 10).
 *
 * A run is a draft first: `POST /ecl-runs` only records the choice of snapshot,
 * model configuration version and scenario set version, and answers with the
 * engine's own readiness assessment. Execution is a separate, permissioned step
 * on the detail screen, so this page never pretends that pressing one button
 * produced a number.
 *
 * The three pickers are the point of the form. Locking a run to explicit versions
 * is what makes acceptance criterion 4 hold — later edits to the model or the
 * scenario set cannot reach back into a completed run.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Info, Plus, RefreshCw } from 'lucide-react';
import type { EclRunSummaryRecord, RunStatus } from '@eclens/shared';
import { formatDate, formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { Badge, type BadgeTone, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useServerList } from '@/hooks/useServerList';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';

const column = createColumnHelper<EclRunSummaryRecord>();

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

/** Statuses where a job is still working, so the list keeps polling. */
const IN_FLIGHT: RunStatus[] = ['PENDING', 'RUNNING'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

export function EclRunsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { can } = useAuth();
  const { moneyString, percentString } = useSettings();

  const [createOpen, setCreateOpen] = useState(false);
  const [runDate, setRunDate] = useState(todayIsoDate);
  const [snapshotId, setSnapshotId] = useState('');
  const [modelConfigurationId, setModelConfigurationId] = useState('');
  const [scenarioSetId, setScenarioSetId] = useState('');
  const [notes, setNotes] = useState('');

  // `snapshotId` is the only filter this endpoint honours besides `search`.
  const list = useServerList<{ snapshotId?: string }>({}, { sortBy: 'createdAt', sortDir: 'desc' });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['ecl-runs', list.query],
    queryFn: () => api.runs.list(list.query),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => IN_FLIGHT.includes(run.status)) ? 2000 : false,
  });

  const snapshots = useQuery({
    queryKey: ['portfolio-snapshots'],
    queryFn: () => api.portfolio.listSnapshots(),
    enabled: createOpen,
  });

  const configurations = useQuery({
    queryKey: ['model-configurations'],
    queryFn: () =>
      api.modelConfigurations.list({ page: 1, pageSize: 50, sortDir: 'desc', sortBy: 'createdAt' }),
    enabled: createOpen,
  });

  const scenarioSets = useQuery({
    queryKey: ['scenario-sets'],
    queryFn: () =>
      api.scenarios.list({ page: 1, pageSize: 50, sortDir: 'desc', sortBy: 'createdAt' }),
    enabled: createOpen,
  });
  /** A run can only be created against a set someone has explicitly approved. */
  const approvedScenarioSets = (scenarioSets.data?.items ?? []).filter(
    (set) => set.approvalStatus === 'APPROVED',
  );

  const create = useMutation({
    mutationFn: () =>
      api.runs.create({
        runDate: runDate.trim(),
        snapshotId,
        modelConfigurationId,
        scenarioSetId,
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      }),
    onSuccess: (run) => {
      setCreateOpen(false);
      push(
        'success',
        `Draft run ${run.publicId} created`,
        run.readiness.ready
          ? 'Ready to execute. The run is locked to the versions you selected.'
          : `Created, but not ready to execute: ${run.readiness.checks.filter((c) => !c.ok).length} check(s) failed.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['ecl-runs'] });
      navigate(`/ecl-runs/${run.publicId}`);
    },
    onError: (error) =>
      push('error', 'Run not created', messageOf(error, 'The draft run could not be created.')),
  });

  const canCreate = can('run:create');
  const runs = data?.items ?? [];

  const columns = [
    column.accessor('publicId', {
      header: 'Run',
      enableSorting: false,
      cell: (info) => <span className="font-medium text-navy-800">{info.getValue()}</span>,
    }),
    column.accessor('runDate', {
      header: 'Reporting date',
      cell: (info) => (
        <span className="whitespace-nowrap tabular-nums">{formatDate(info.getValue())}</span>
      ),
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (info) => (
        <Badge tone={STATUS_TONE[info.getValue()]}>{info.getValue().toLowerCase()}</Badge>
      ),
    }),
    column.accessor('totalLossAllowance', {
      header: 'Loss allowance',
      enableSorting: false,
      cell: (info) =>
        info.getValue() === null ? (
          <span className="tabular-nums text-slate-400">—</span>
        ) : (
          <span className="font-medium tabular-nums text-red-700">
            {moneyString(info.getValue())}
          </span>
        ),
    }),
    column.accessor('coverageRatio', {
      header: 'Coverage',
      enableSorting: false,
      cell: (info) =>
        info.getValue() === null ? (
          <span className="tabular-nums text-slate-400">—</span>
        ) : (
          <span className="tabular-nums text-slate-600">{percentString(info.getValue())}</span>
        ),
    }),
    column.accessor('modelConfigurationVersion', {
      header: 'Model',
      enableSorting: false,
      cell: (info) => <span className="text-xs text-slate-500">v{info.getValue()}</span>,
    }),
    column.accessor('scenarioSetVersion', {
      header: 'Scenarios',
      enableSorting: false,
      cell: (info) => <span className="text-xs text-slate-500">v{info.getValue()}</span>,
    }),
    column.accessor('createdByName', { header: 'Created by', enableSorting: false }),
    column.accessor('completedAt', {
      header: 'Completed',
      cell: (info) => {
        const completedAt = info.getValue();
        return completedAt === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className="whitespace-nowrap text-slate-600">{formatDateTime(completedAt)}</span>
        );
      },
    }),
  ];

  const draftValid =
    ISO_DATE.test(runDate.trim()) &&
    snapshotId !== '' &&
    modelConfigurationId !== '' &&
    scenarioSetId !== '';

  return (
    <div>
      <PageHeader
        title="ECL calculation runs"
        description="Every run stores the snapshot, model configuration version and scenario set version it executed with, so any allowance figure can be traced and reproduced after those assumptions are superseded."
        tags={<SyntheticBadge />}
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
            {canCreate ? (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setCreateOpen(true)}
              >
                New run
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <CardHeader
          title="Run history"
          description="Select a run to inspect its readiness, results and review state."
          actions={
            <div className="flex w-72 items-center gap-2">
              <Input
                aria-label="Search runs"
                placeholder="Search run id, creator or notes…"
                value={list.searchInput}
                onChange={(event) => list.setSearchInput(event.target.value)}
              />
            </div>
          }
        />
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={runs}
              loading={isLoading}
              getRowId={(run) => run.publicId}
              onRowClick={(run) => navigate(`/ecl-runs/${run.publicId}`)}
              manualSorting
              sorting={list.sortingState}
              onSortingChange={list.applySorting}
              emptyTitle="No runs yet"
              emptyDescription="Create a draft run against a committed snapshot to compute the allowance."
              emptyAction={
                canCreate ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    New run
                  </Button>
                ) : undefined
              }
            />
            {data ? (
              <Pagination meta={data.meta} onPageChange={list.setPage} loading={isLoading} />
            ) : null}
          </>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a draft run"
        description="Nothing is calculated yet. The draft records which versions the run will be locked to, and the engine reports whether it is ready to execute."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!draftValid}
              onClick={() => create.mutate()}
            >
              Create draft
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Reporting date"
              type="date"
              value={runDate}
              onChange={(event) => setRunDate(event.target.value)}
              error={ISO_DATE.test(runDate.trim()) ? undefined : 'Use YYYY-MM-DD.'}
              hint="The date every period is measured from."
            />
            <Select
              label="Portfolio snapshot"
              value={snapshotId}
              onChange={(event) => setSnapshotId(event.target.value)}
              hint="The input version the run cites. Snapshots are immutable."
            >
              <option value="">
                {snapshots.isLoading ? 'Loading snapshots…' : 'Select a snapshot…'}
              </option>
              {(snapshots.data ?? []).map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {snapshot.label} — {formatDate(snapshot.asOfDate)} · {snapshot.exposureCount}{' '}
                  exposure(s) · {snapshot.source.toLowerCase()}
                </option>
              ))}
            </Select>
            <Select
              label="Model configuration"
              value={modelConfigurationId}
              onChange={(event) => setModelConfigurationId(event.target.value)}
              hint="Superseding this version later will not change the run."
            >
              <option value="">
                {configurations.isLoading ? 'Loading versions…' : 'Select a version…'}
              </option>
              {(configurations.data?.items ?? []).map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name} v{config.version}
                  {config.isActive ? ' (active)' : ''}
                </option>
              ))}
            </Select>
            <Select
              label="Scenario set"
              value={scenarioSetId}
              onChange={(event) => setScenarioSetId(event.target.value)}
              hint={
                approvedScenarioSets.length === 0 && !scenarioSets.isLoading
                  ? 'No scenario set is approved yet — approve one on the Macro Scenarios page first.'
                  : 'The active weights must total exactly 1 — the engine re-checks in decimal arithmetic. Only approved sets are offered here.'
              }
            >
              <option value="">
                {scenarioSets.isLoading ? 'Loading scenario sets…' : 'Select a scenario set…'}
              </option>
              {approvedScenarioSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name} v{set.version}
                  {set.isActive ? ' (active)' : ''} — {set.scenarios.length} scenario(s)
                </option>
              ))}
            </Select>
          </div>

          <Input
            label="Notes"
            value={notes}
            placeholder="Optional. Shown on the run and searchable from this list."
            onChange={(event) => setNotes(event.target.value)}
          />

          <p className="flex items-start gap-2 rounded-lg border border-navy-200 bg-navy-50 px-3 py-2 text-2xs leading-relaxed text-navy-800">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            After the draft is created you will land on the run screen, which shows the readiness
            checks and the Execute button. Execution is gated separately on{' '}
            <code className="mx-1">run:execute</code>, and an approved run is locked — its results
            and versions are frozen.
          </p>
        </div>
      </Modal>
    </div>
  );
}
