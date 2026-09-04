import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { CheckCircle2, MessageSquare, SearchX, ShieldAlert } from 'lucide-react';
import type { ExceptionItemRecord, ExceptionKind } from '@eclens/shared';
import { EXCEPTION_KINDS, formatDateTime } from '@eclens/shared';
import { ApiError } from '@/api/http';
import { api } from '@/api/client';
import { QualityInvestigationPanel } from '@/components/ai/QualityInvestigationPanel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useServerList } from '@/hooks/useServerList';
import { useAuth } from '@/providers/AuthProvider';

const column = createColumnHelper<ExceptionItemRecord>();

type ExceptionStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
type ExceptionSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

const KIND_LABEL: Record<ExceptionKind, string> = {
  DATA_QUALITY: 'Data quality',
  ANALYST_OVERRIDE: 'Analyst override',
  LARGE_ECL_CHANGE: 'Large ECL change',
  NEAR_STAGING_THRESHOLD: 'Near staging threshold',
};

const KIND_TONE: Record<ExceptionKind, BadgeTone> = {
  DATA_QUALITY: 'warning',
  ANALYST_OVERRIDE: 'info',
  LARGE_ECL_CHANGE: 'danger',
  NEAR_STAGING_THRESHOLD: 'neutral',
};

const SEVERITY_TONE: Record<ExceptionSeverity, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
};

const STATUS_TONE: Record<ExceptionStatus, BadgeTone> = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warning',
  RESOLVED: 'positive',
};

/**
 * The exception queue (implementation task 12). Triage is one-way — an item can
 * only move OPEN → ACKNOWLEDGED → RESOLVED — so the server rejects a repeat
 * transition with a 409 and the UI surfaces that message rather than pretending
 * the second click did something.
 */
export function ExceptionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { can } = useAuth();
  const canTriage = can('exposure:override');
  const canUseAi = can('ai:use');

  const list = useServerList<{
    kind?: ExceptionKind;
    severity?: ExceptionSeverity;
    status?: ExceptionStatus;
  }>({});

  const [selected, setSelected] = useState<ExceptionItemRecord | null>(null);
  const [triage, setTriage] = useState<{ item: ExceptionItemRecord; action: 'acknowledge' | 'resolve' } | null>(null);
  const [note, setNote] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['exceptions', list.query],
    queryFn: () => api.exceptions.list(list.query),
  });

  const { data: summary } = useQuery({
    queryKey: ['exceptions-summary'],
    queryFn: () => api.exceptions.summary(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    void queryClient.invalidateQueries({ queryKey: ['exceptions-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
  };

  const triageMutation = useMutation({
    mutationFn: async ({ item, action, comment }: { item: ExceptionItemRecord; action: 'acknowledge' | 'resolve'; comment: string }) =>
      action === 'acknowledge'
        ? api.exceptions.acknowledge(item.id, comment || undefined)
        : api.exceptions.resolve(item.id, comment || undefined),
    onSuccess: (exception, variables) => {
      push(
        'success',
        variables.action === 'acknowledge' ? 'Exception acknowledged' : 'Exception resolved',
        exception.title,
      );
      setTriage(null);
      setNote('');
      setSelected(null);
      invalidate();
    },
    onError: (error: unknown) => {
      // A 409 here means somebody triaged the item first; show the server's reason.
      const message = error instanceof ApiError ? error.message : 'The exception could not be updated.';
      push('error', 'Triage rejected', message);
      invalidate();
    },
  });

  const openTriage = (item: ExceptionItemRecord, action: 'acknowledge' | 'resolve') => {
    setNote('');
    setTriage({ item, action });
  };

  const columns = [
    column.accessor('exposurePublicId', {
      header: 'Exposure',
      cell: (info) => {
        const publicId = info.getValue();
        if (!publicId) return <span className="text-slate-400">Portfolio-level</span>;
        return (
          <div>
            <Link
              to={`/portfolio/${publicId}`}
              className="font-medium text-navy-800 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {publicId}
            </Link>
            <p className="text-[11px] text-slate-500">{info.row.original.borrowerName ?? '—'}</p>
          </div>
        );
      },
    }),
    column.accessor('kind', {
      header: 'Kind',
      cell: (info) => <Badge tone={KIND_TONE[info.getValue()]}>{KIND_LABEL[info.getValue()]}</Badge>,
    }),
    column.accessor('severity', {
      header: 'Severity',
      cell: (info) => <Badge tone={SEVERITY_TONE[info.getValue()]}>{info.getValue().toLowerCase()}</Badge>,
    }),
    column.accessor('title', {
      header: 'Finding',
      cell: (info) => (
        <div className="max-w-md">
          <p className="font-medium text-slate-800">{info.getValue()}</p>
          <p className="truncate text-[11px] text-slate-500">{info.row.original.detail}</p>
        </div>
      ),
    }),
    column.accessor('metric', {
      header: 'Metric',
      cell: (info) => <span className="tabular-nums text-xs text-slate-600">{info.getValue() ?? '—'}</span>,
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (info) => <Badge tone={STATUS_TONE[info.getValue()]}>{info.getValue().toLowerCase()}</Badge>,
    }),
    column.accessor('createdAt', {
      header: 'Raised',
      cell: (info) => <span className="tabular-nums text-xs text-slate-500">{formatDateTime(info.getValue())}</span>,
    }),
    column.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const item = info.row.original;
        if (!canTriage || item.status === 'RESOLVED') return null;
        return (
          <span className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>
            {item.status === 'OPEN' ? (
              <Button size="sm" variant="ghost" onClick={() => openTriage(item, 'acknowledge')}>
                Acknowledge
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => openTriage(item, 'resolve')}>
              Resolve
            </Button>
          </span>
        );
      },
    }),
  ];

  const rows = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Exception queue"
        description="Data-quality findings, analyst overrides, unusually large ECL movements and exposures sitting close to a staging threshold. Each one is triaged by a named human and the transition is written to the audit trail."
        tags={<Badge tone="neutral">{summary ? `${summary.open} open` : '—'}</Badge>}
      />

      {summary ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['Open', summary.open, 'danger'],
              ['Acknowledged', summary.acknowledged, 'warning'],
              ['Resolved', summary.resolved, 'positive'],
              ['Total raised', summary.total, 'neutral'],
            ] as const
          ).map(([label, value, tone]) => (
            <Card key={label} className="flex items-center justify-between px-4 py-3">
              <span className="text-xs font-medium text-slate-600">{label}</span>
              <Badge tone={tone}>{value.toLocaleString('en-US')}</Badge>
            </Card>
          ))}
        </div>
      ) : null}

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_190px_150px_160px]">
          <Input
            aria-label="Search exceptions"
            placeholder="Search finding, exposure or borrower…"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
          />
          <Select
            aria-label="Filter by kind"
            value={list.filters.kind ?? ''}
            onChange={(event) =>
              list.setFilter('kind', event.target.value === '' ? undefined : (event.target.value as ExceptionKind))
            }
          >
            <option value="">All kinds</option>
            {EXCEPTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by severity"
            value={list.filters.severity ?? ''}
            onChange={(event) =>
              list.setFilter('severity', event.target.value === '' ? undefined : (event.target.value as ExceptionSeverity))
            }
          >
            <option value="">All severities</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </Select>
          <Select
            aria-label="Filter by status"
            value={list.filters.status ?? ''}
            onChange={(event) =>
              list.setFilter('status', event.target.value === '' ? undefined : (event.target.value as ExceptionStatus))
            }
          >
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="RESOLVED">Resolved</option>
          </Select>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Findings"
          description={
            summary
              ? `${summary.bySeverity.HIGH ?? 0} high · ${summary.bySeverity.MEDIUM ?? 0} medium · ${summary.bySeverity.LOW ?? 0} low`
              : undefined
          }
          actions={
            list.hasActiveFilters ? (
              <Button size="sm" variant="ghost" onClick={list.reset}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : !isLoading && rows.length === 0 && list.hasActiveFilters ? (
          <EmptyState
            icon={<SearchX className="h-8 w-8" />}
            title="No exceptions match your filters"
            description="Widen the kind, severity or status filter to see more of the queue."
            action={
              <Button size="sm" variant="secondary" onClick={list.reset}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            loading={isLoading}
            getRowId={(row) => row.id}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="The queue is empty"
            emptyDescription="No data-quality, override, movement or threshold findings have been raised."
            emptyAction={
              <Button size="sm" onClick={() => navigate('/ecl-runs')}>
                Open ECL runs
              </Button>
            }
          />
        )}
        {data ? <Pagination meta={data.meta} onPageChange={list.setPage} loading={isLoading} /> : null}
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
        <ShieldAlert className="h-3.5 w-3.5" />
        Triage moves in one direction only: open → acknowledged → resolved. A repeat transition is rejected by the API.
      </p>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.title : ''}
        description={selected ? `${KIND_LABEL[selected.kind]} · raised ${formatDateTime(selected.createdAt)}` : undefined}
        footer={
          selected && canTriage && selected.status !== 'RESOLVED' ? (
            <span className="flex justify-end gap-2">
              {selected.status === 'OPEN' ? (
                <Button variant="secondary" onClick={() => openTriage(selected, 'acknowledge')}>
                  Acknowledge
                </Button>
              ) : null}
              <Button onClick={() => openTriage(selected, 'resolve')}>Resolve</Button>
            </span>
          ) : undefined
        }
      >
        {selected ? (
          <dl className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone={SEVERITY_TONE[selected.severity]}>{selected.severity.toLowerCase()} severity</Badge>
              <Badge tone={STATUS_TONE[selected.status]}>{selected.status.toLowerCase()}</Badge>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-slate-400">Finding</dt>
              <dd className="mt-0.5 leading-relaxed text-slate-700">{selected.detail}</dd>
            </div>
            {selected.metric ? (
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-slate-400">Metric</dt>
                <dd className="mt-0.5 font-mono text-xs text-slate-700">{selected.metric}</dd>
              </div>
            ) : null}
            {selected.exposurePublicId ? (
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-slate-400">Exposure</dt>
                <dd className="mt-0.5">
                  <Link to={`/portfolio/${selected.exposurePublicId}`} className="font-medium text-navy-800 hover:underline">
                    {selected.exposurePublicId}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">{selected.borrowerName ?? ''}</span>
                </dd>
              </div>
            ) : null}
            {selected.acknowledgedBy ? (
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-slate-400">Acknowledged</dt>
                <dd className="mt-0.5 text-xs text-slate-600">
                  {selected.acknowledgedBy} · {formatDateTime(selected.acknowledgedAt ?? '')}
                </dd>
              </div>
            ) : null}
            {!canTriage ? (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                Your role can read the queue but cannot triage it. Triage requires the <code>exposure:override</code>{' '}
                permission.
              </p>
            ) : null}
          </dl>
        ) : null}

        {/*
          Mounted inside the drawer rather than beside the table: the investigation
          is about *this* exception, and rendering it at page level would detach it
          from the item it explains. Read-only — the panel has no apply action and
          the server exposes no tool that could supply one.
        */}
        {selected && canUseAi ? (
          <div className="mt-4 border-t border-slate-200 pt-4">
            <QualityInvestigationPanel
              request={{ exceptionId: selected.id }}
              subjectLabel={selected.exposurePublicId ?? 'this portfolio-level finding'}
            />
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={triage !== null}
        onClose={() => setTriage(null)}
        size="sm"
        title={triage?.action === 'resolve' ? 'Resolve exception' : 'Acknowledge exception'}
        description={triage?.item.title}
        footer={
          <span className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTriage(null)}>
              Cancel
            </Button>
            <Button
              icon={triage?.action === 'resolve' ? <CheckCircle2 className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
              loading={triageMutation.isPending}
              onClick={() =>
                triage
                  ? triageMutation.mutate({ item: triage.item, action: triage.action, comment: note })
                  : undefined
              }
            >
              {triage?.action === 'resolve' ? 'Resolve' : 'Acknowledge'}
            </Button>
          </span>
        }
      >
        <label className="block text-xs font-medium text-slate-600" htmlFor="triage-note">
          Note for the audit trail (optional)
        </label>
        <textarea
          id="triage-note"
          className="mt-1.5 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-navy-400 focus:outline-none focus:ring-2 focus:ring-navy-100"
          rows={4}
          maxLength={500}
          placeholder={
            triage?.action === 'resolve'
              ? 'What was corrected, and which run or import reflects the fix?'
              : 'Who is looking at this, and what is the next step?'
          }
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal>
    </div>
  );
}
