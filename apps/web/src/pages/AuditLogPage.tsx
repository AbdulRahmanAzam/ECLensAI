/**
 * The immutable audit trail (implementation task 13).
 *
 * Paging, sorting and filtering all happen in the API — the trail grows without
 * bound, so a client-side filter here would only ever search the page already on
 * screen. There is deliberately no write surface: the API exposes no update or
 * delete route, so nothing reachable from this page can alter history.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ScrollText, SearchX } from 'lucide-react';
import type { AuditEventRecord, RoleName } from '@eclens/shared';
import { AUDIT_ACTIONS, formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useServerList } from '@/hooks/useServerList';

const column = createColumnHelper<AuditEventRecord>();

const ROLE_TONE: Record<RoleName, BadgeTone> = {
  ADMIN: 'info',
  RISK_ANALYST: 'neutral',
  REVIEWER: 'positive',
  AUDITOR: 'warning',
};

const ROLE_LABEL: Record<RoleName, string> = {
  ADMIN: 'Admin',
  RISK_ANALYST: 'Risk Analyst',
  REVIEWER: 'Reviewer',
  AUDITOR: 'Auditor',
};

const ENTITY_TYPES = [
  'ImportBatch',
  'Exposure',
  'StageOverride',
  'ModelConfiguration',
  'ScenarioSet',
  'EclRun',
  'ExceptionItem',
  'User',
];

/** A type alias, not an interface: `useServerList` constrains filters to
 *  `Record<string, unknown>`, and only object-literal aliases get an implicit
 *  index signature. */
type AuditFilters = {
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
};

export function AuditLogPage() {
  const list = useServerList<AuditFilters>({}, { sortBy: 'occurredAt', sortDir: 'desc', pageSize: 50 });
  const [selected, setSelected] = useState<AuditEventRecord | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['audit-log', list.query],
    queryFn: () => api.audit.list(list.query),
  });

  // Only these columns are in the service's sort whitelist. `orderBy` ignores an
  // unlisted `sortBy` and silently falls back to the default ordering, so a
  // header arrow on any other column would promise a sort the server never
  // applies — hence display-only.
  const columns = [
    column.accessor('occurredAt', {
      header: 'When',
      cell: (info) => <span className="whitespace-nowrap tabular-nums text-slate-600">{formatDateTime(info.getValue())}</span>,
    }),
    column.accessor('userName', { header: 'User' }),
    column.accessor('role', {
      header: 'Role',
      cell: (info) => <Badge tone={ROLE_TONE[info.getValue()]}>{ROLE_LABEL[info.getValue()]}</Badge>,
    }),
    column.accessor('action', {
      header: 'Action',
      cell: (info) => <code className="font-mono text-[11px] font-medium text-navy-800">{info.getValue()}</code>,
    }),
    column.accessor('entityType', {
      header: 'Entity',
      cell: (info) => (
        <div>
          <p className="text-slate-700">{info.getValue()}</p>
          <p className="font-mono text-[11px] text-slate-400">{info.row.original.entityId}</p>
        </div>
      ),
    }),
    column.accessor('detail', {
      header: 'Detail',
      enableSorting: false,
      cell: (info) => <span className="text-xs text-slate-500">{info.getValue()}</span>,
    }),
    column.accessor('ipAddress', {
      header: 'IP',
      enableSorting: false,
      cell: (info) => <span className="tabular-nums text-slate-400">{info.getValue() ?? '—'}</span>,
    }),
  ];

  const rows = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="An immutable record of every user and system action. Auditors can reproduce exactly who did what, and when."
        tags={<Badge tone="neutral">{data?.meta.totalItems.toLocaleString('en-US') ?? 0} events</Badge>}
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_200px_160px_150px_150px]">
          <Input
            aria-label="Search audit log"
            placeholder="Search user, action, entity or detail…"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
          />
          <Select
            aria-label="Filter by action"
            value={list.filters.action ?? ''}
            onChange={(event) => list.setFilter('action', event.target.value || undefined)}
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by entity type"
            value={list.filters.entityType ?? ''}
            onChange={(event) => list.setFilter('entityType', event.target.value || undefined)}
          >
            <option value="">All entity types</option>
            {ENTITY_TYPES.map((entityType) => (
              <option key={entityType} value={entityType}>
                {entityType}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            aria-label="From date"
            value={list.filters.from ?? ''}
            onChange={(event) => list.setFilter('from', event.target.value || undefined)}
          />
          <Input
            type="date"
            aria-label="To date"
            value={list.filters.to ?? ''}
            onChange={(event) => list.setFilter('to', event.target.value || undefined)}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Event trail"
          description="Newest first. Every entry names the actor, their role, the action code and the entity it touched."
          actions={
            list.hasActiveFilters ? (
              <Button size="sm" variant="secondary" onClick={list.reset}>
                Clear filters
              </Button>
            ) : null
          }
        />
        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : !isLoading && rows.length === 0 && list.hasActiveFilters ? (
          <EmptyState
            icon={<SearchX className="h-8 w-8" />}
            title="No events match your filters"
            description="Try a different search term, widen the date range, or reset the action and entity filters."
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
            manualSorting
            sorting={list.sortingState}
            onSortingChange={list.applySorting}
            onRowClick={(row) => setSelected(row)}
            emptyTitle="No audit events"
            emptyDescription="Actions taken in the workspace will be recorded here."
          />
        )}
        {data ? <Pagination meta={data.meta} onPageChange={list.setPage} loading={isLoading} /> : null}
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
        <ScrollText className="h-3.5 w-3.5" />
        Events are append-only. The API exposes no update or delete route, so the trail cannot be edited by anyone who
        can reach it — including administrators.
      </p>

      <Drawer open={selected !== null} onClose={() => setSelected(null)} title="Audit event" description={selected?.action}>
        {selected ? (
          <dl className="space-y-3 text-sm">
            {(
              [
                ['Occurred at', formatDateTime(selected.occurredAt)],
                ['Actor', selected.userName],
                ['Role', ROLE_LABEL[selected.role]],
                ['Action', selected.action],
                ['Entity type', selected.entityType],
                ['Entity id', selected.entityId],
                ['IP address', selected.ipAddress ?? '—'],
                ['Request id', selected.requestId ?? '—'],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="border-b border-slate-100 pb-2 last:border-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-slate-800">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Detail</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{selected.detail}</dd>
            </div>
            <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
              <ScrollText className="h-3.5 w-3.5 shrink-0" />
              This record is immutable — there is no route that can edit or delete it.
            </p>
          </dl>
        ) : null}
      </Drawer>
    </div>
  );
}
