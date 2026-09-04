/**
 * Portfolio ingestion (acceptance criterion 1, implementation tasks 4 and 5).
 *
 * The whole flow lives here: upload → preview → map columns → read the
 * validation report → commit the valid rows into an immutable snapshot. Each
 * step is a separate endpoint, and each is audited, so the screen mirrors the
 * API rather than collapsing it.
 *
 * Two rules shape the UI. First, nothing is repaired silently: a row with an
 * ambiguous percentage or an unparseable date is quarantined and reported with
 * its raw value, and the analyst chooses the normalization mode explicitly.
 * Second, the batch drives its own permissions — a committed batch cannot be
 * re-mapped, and only a `VALIDATED` batch can be committed, so the buttons are
 * disabled by status rather than left to fail.
 *
 * Every sub-route resolves the batch by its **public** id, so that is what is
 * passed throughout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Info,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  ImportBatchRecord,
  ImportIssuesRecord,
  ImportMappingSuggestion,
  ImportPreviewRecord,
  ImportStatus,
  IssueSeverity,
  PortfolioField,
} from '@eclens/shared';
import {
  FIELD_SPECS,
  PERCENTAGE_NORMALIZATION_MODES,
  PORTFOLIO_FIELDS,
  REQUIRED_FIELDS,
  formatDateTime,
  formatNumber,
} from '@eclens/shared';
import type { PercentageNormalizationMode } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { ImportMappingPanel } from '@/components/ai/ImportMappingPanel';
import { Badge, type BadgeTone, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useServerList } from '@/hooks/useServerList';
import { mergeAiMappingSuggestions } from '@/lib/ai';
import { useAuth } from '@/providers/AuthProvider';

const column = createColumnHelper<ImportBatchRecord>();

const STATUS_TONE: Record<ImportStatus, BadgeTone> = {
  QUEUED: 'neutral',
  UPLOADED: 'neutral',
  MAPPING: 'info',
  VALIDATING: 'info',
  VALIDATED: 'positive',
  QUARANTINED: 'warning',
  COMMITTED: 'info',
  IMPORTED: 'positive',
  FAILED: 'danger',
};

const SEVERITY_TONE: Record<IssueSeverity, BadgeTone> = {
  ERROR: 'danger',
  WARNING: 'warning',
  INFO: 'info',
};

const NORMALIZATION_LABEL: Record<PercentageNormalizationMode, string> = {
  AS_DECIMAL: 'Values are already decimals (0.0425 = 4.25%)',
  PERCENT_TO_DECIMAL: 'Values are percentages (4.25 = 4.25%) — divide by 100',
  AUTO_DETECT: 'Auto-detect per column, and flag anything ambiguous',
};

/**
 * Statuses that mean a job is still running, so the list keeps polling.
 * `COMMITTED` is included because the commit endpoint answers 202 and writes the
 * ledger asynchronously.
 */
const IN_FLIGHT: ImportStatus[] = ['QUEUED', 'VALIDATING', 'COMMITTED'];
const isInFlight = (status: ImportStatus): boolean => IN_FLIGHT.includes(status);

/** `''` is the form's "not mapped" sentinel; the API wants `null`. */
type MappingDraft = Record<PortfolioField, string>;

function initialMapping(batch: ImportBatchRecord): MappingDraft {
  const draft = {} as MappingDraft;
  for (const field of PORTFOLIO_FIELDS) {
    draft[field] = batch.mapping[field] ?? batch.suggestedMapping[field]?.header ?? '';
  }
  return draft;
}

function toMappingRequest(draft: MappingDraft): Record<string, string | null> {
  return Object.fromEntries(
    PORTFOLIO_FIELDS.map((field) => [field, draft[field] === '' ? null : draft[field]]),
  );
}

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

// ---------------------------------------------------------------------------
// Batch workflow drawer
// ---------------------------------------------------------------------------

function BatchWorkflow({ batchPublicId }: { batchPublicId: string }) {
  const { can } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [normalization, setNormalization] = useState<PercentageNormalizationMode>('AUTO_DETECT');
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | ''>('');

  const preview = useQuery({
    queryKey: ['import-preview', batchPublicId],
    queryFn: () => api.imports.preview(batchPublicId),
    refetchInterval: (query) =>
      isInFlight(query.state.data?.batch.status ?? 'QUEUED') ? 1500 : false,
  });

  const issues = useQuery({
    queryKey: ['import-issues', batchPublicId],
    queryFn: () => api.imports.issues(batchPublicId),
    enabled: preview.data !== undefined,
    // `ImportIssuesRecord` carries no status of its own, so the poll decision is
    // read off the preview query's batch.
    refetchInterval: () => (isInFlight(preview.data?.batch.status ?? 'QUEUED') ? 1500 : false),
  });

  const batch = preview.data?.batch;

  // Re-seed the form when a different batch is opened or its status changes —
  // deliberately not when `batch` itself changes identity. React Query refetches
  // on window focus, so depending on the record would throw away an analyst's
  // in-progress mapping edits every time they tabbed back to the window.
  useEffect(() => {
    if (!batch) return;
    setDraft(initialMapping(batch));
    setNormalization(batch.percentageNormalizationMode);
    setSnapshotLabel(batch.snapshotLabel ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.publicId, batch?.status]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['import-preview', batchPublicId] });
    void queryClient.invalidateQueries({ queryKey: ['import-issues', batchPublicId] });
    void queryClient.invalidateQueries({ queryKey: ['imports'] });
  };

  const applyMapping = useMutation({
    mutationFn: (input: MappingDraft) =>
      api.imports.applyMapping(batchPublicId, {
        mapping: toMappingRequest(input),
        percentageNormalizationMode: normalization,
        revalidate: true,
      }),
    onSuccess: (updated) => {
      push('success', 'Mapping applied', updated.message);
      refresh();
    },
    onError: (error) =>
      push('error', 'Mapping rejected', messageOf(error, 'The mapping could not be applied.')),
  });

  const commit = useMutation({
    mutationFn: () =>
      api.imports.commit(batchPublicId, {
        ...(snapshotLabel.trim() === '' ? {} : { snapshotLabel: snapshotLabel.trim() }),
        skipDuplicates,
      }),
    onSuccess: (accepted) => {
      push(
        'success',
        'Commit accepted',
        `Job ${accepted.jobId} on the ${accepted.driver} driver. The snapshot appears in the run builder once it lands.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio-snapshots'] });
      refresh();
    },
    onError: (error) =>
      push('error', 'Commit rejected', messageOf(error, 'The batch could not be committed.')),
  });

  const missingRequired = useMemo(
    () => (draft ? REQUIRED_FIELDS.filter((field) => draft[field] === '') : []),
    [draft],
  );

  const canMap = can('import:map');
  // Gated on both: the suggestion itself only needs `ai:use`, but staging it is
  // pointless for a role that cannot apply a mapping, and showing the button to
  // that role would invite a click that silently does nothing.
  const canUseAiMapping = can('ai:use') && canMap;

  if (preview.isError) return <ErrorState onRetry={() => void preview.refetch()} />;
  if (!preview.data || !batch || !draft) return <Skeleton className="h-64" />;

  const previewRecord: ImportPreviewRecord = preview.data;
  const issuesRecord: ImportIssuesRecord | undefined = issues.data;
  const inFlight = isInFlight(batch.status);

  /**
   * Folds the AI's suggestions into the editable draft and reports what moved.
   *
   * The diff is named field by field rather than summarised as a count: a dozen
   * selects changing at once is indistinguishable from a form that has broken,
   * and the analyst is entitled to see which column went where before pressing
   * apply. Nothing is written to the server here — the existing "Apply mapping
   * and re-validate" button remains the only thing that persists a mapping.
   */
  const stageAiSuggestions = (suggestions: ImportMappingSuggestion[]) => {
    const { draft: next, changes } = mergeAiMappingSuggestions(suggestions, draft);
    if (changes.length === 0) {
      push('info', 'Nothing to stage', 'Every suggestion already matches the column mapping form.');
      return;
    }
    setDraft(next);
    const shown = changes
      .slice(0, 4)
      .map(
        (change) =>
          `${change.field}: ${change.from === '' ? 'unmapped' : change.from} → ${change.to}`,
      );
    const remaining = changes.length - shown.length;
    push(
      'info',
      `${changes.length} mapping change${changes.length === 1 ? '' : 's'} staged, not applied`,
      `${shown.join(' · ')}${remaining > 0 ? ` · and ${remaining} more` : ''}. Review the selects below, then apply the mapping yourself.`,
    );
  };

  const visibleIssues = (issuesRecord?.issues ?? []).filter(
    (issue) => severityFilter === '' || issue.severity === severityFilter,
  );

  return (
    <div className="space-y-5">
      {inFlight ? (
        <p className="flex items-center gap-2 rounded-lg border border-navy-200 bg-navy-50 px-3 py-2 text-xs text-navy-800">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {batch.status === 'COMMITTED'
            ? 'Writing the snapshot to the ledger…'
            : 'Validating rows…'}{' '}
          This panel refreshes itself.
        </p>
      ) : null}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Import summary
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">Rows read</dt>
            <dd className="tabular-nums font-semibold text-slate-900">
              {formatNumber(batch.rowCount)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Valid</dt>
            <dd className="tabular-nums font-semibold text-emerald-700">
              {formatNumber(batch.validRowCount)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Quarantined</dt>
            <dd className="tabular-nums font-semibold text-amber-700">
              {formatNumber(batch.quarantinedRowCount)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Errors / warnings</dt>
            <dd className="tabular-nums font-semibold text-slate-900">
              {batch.errorCount} / {batch.warningCount}
            </dd>
          </div>
        </dl>
        <p className="mt-1.5 text-xs text-slate-600">{batch.message}</p>
        {batch.truncated ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-2xs text-amber-700">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            Only the first rows were parsed; {formatNumber(batch.rowsSkippedByTruncation)} were
            skipped by the bounded-memory reader. Split the file to import the rest.
          </p>
        ) : null}
        {batch.unmappedHeaders.length > 0 ? (
          <p className="mt-1.5 text-2xs text-slate-500">
            Columns in the file that no field claims:{' '}
            <code>{batch.unmappedHeaders.join(', ')}</code>
          </p>
        ) : null}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Column mapping
        </h3>
        <p className="mb-2 text-2xs leading-relaxed text-slate-500">
          The suggestions are deterministic string scoring against the canonical field labels and
          aliases — no model inference — so the same file always proposes the same mapping.
          Low-confidence guesses are marked and need your confirmation.
        </p>

        {/*
          Above the selects it fills, and beside the deterministic proposal it is
          meant to be compared with. Keyed on the batch so a suggestion read from
          one file cannot survive a switch to another.
        */}
        {canUseAiMapping ? (
          <div className="mb-3">
            <ImportMappingPanel
              key={batch.publicId}
              batchId={batchPublicId}
              batchLabel={batch.fileName}
              onUseSuggestions={stageAiSuggestions}
            />
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          {PORTFOLIO_FIELDS.map((field) => {
            const spec = FIELD_SPECS[field];
            const suggestion = batch.suggestedMapping[field];
            return (
              <div key={field} className="flex items-start gap-2">
                <div className="w-40 shrink-0 pt-1.5">
                  <p className="text-xs font-medium text-slate-800">
                    {spec.label}
                    {spec.required ? <span className="ml-1 text-red-600">*</span> : null}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    <code>{field}</code> · {spec.kind}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <Select
                    value={draft[field]}
                    disabled={!can('import:map') || inFlight}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current!, [field]: event.target.value }))
                    }
                    aria-label={spec.label}
                  >
                    <option value="">— not mapped —</option>
                    {batch.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </Select>
                  {suggestion ? (
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      suggested on {suggestion.matchedOn.toLowerCase()} ·{' '}
                      {(suggestion.confidence * 100).toFixed(0)}% confidence
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3">
          <Select
            label="Percentage normalization"
            value={normalization}
            disabled={!can('import:map') || inFlight}
            onChange={(event) =>
              setNormalization(event.target.value as PercentageNormalizationMode)
            }
            hint={NORMALIZATION_LABEL[normalization]}
          >
            {PERCENTAGE_NORMALIZATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </div>

        {missingRequired.length > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-2xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            Required and still unmapped: <code>{missingRequired.join(', ')}</code>. The batch will
            fail validation until these are mapped.
          </p>
        ) : null}

        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          loading={applyMapping.isPending}
          disabled={!can('import:map') || inFlight || missingRequired.length > 0}
          onClick={() => applyMapping.mutate(draft)}
        >
          Apply mapping and re-validate
        </Button>
        {!can('import:map') ? (
          <p className="mt-1.5 text-2xs text-slate-400">
            Your role cannot change a column mapping.
          </p>
        ) : null}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Preview — first {previewRecord.previewRows.length} row(s) as uploaded
        </h3>
        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-2xs">
            <thead className="sticky top-0 bg-surface-2 text-slate-500">
              <tr>
                <th className="whitespace-nowrap px-2 py-1.5 font-medium">Row</th>
                {batch.headers.map((header) => (
                  <th key={header} className="whitespace-nowrap px-2 py-1.5 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {previewRecord.previewRows.map((row) => (
                <tr key={row.rowNumber}>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-400">
                    {row.rowNumber}
                  </td>
                  {row.cells.map((cell, index) => (
                    <td
                      key={`${row.rowNumber}-${index}`}
                      className="whitespace-nowrap px-2 py-1.5 text-slate-700"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Validation issues{' '}
            <span className="ml-1 normal-case text-slate-400">
              ({issuesRecord?.issues.length ?? 0} total, {issuesRecord?.quarantinedRows.length ?? 0}{' '}
              row(s) quarantined)
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <Select
              className="h-7 w-40 text-xs"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value as IssueSeverity | '')}
              aria-label="Filter by severity"
            >
              <option value="">All severities</option>
              <option value="ERROR">Errors only</option>
              <option value="WARNING">Warnings only</option>
              <option value="INFO">Info only</option>
            </Select>
          </div>
        </div>

        {issues.isError ? (
          <ErrorState
            title="The issue report could not be loaded"
            onRetry={() => void issues.refetch()}
          />
        ) : issues.isLoading ? (
          <Skeleton className="h-32" />
        ) : visibleIssues.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            No issues at this severity. Every row that reached the validator parsed cleanly.
          </p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-lg border border-line">
            <table className="w-full text-left text-2xs">
              <thead className="sticky top-0 bg-surface-2 text-slate-500">
                <tr>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Row</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Field</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Raw value</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Issue</th>
                  <th className="px-2 py-1.5 font-medium">Message</th>
                  <th className="px-2 py-1.5 font-medium">Suggested correction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {visibleIssues.map((issue, index) => (
                  <tr
                    key={`${issue.rowNumber}-${issue.field}-${issue.issueCode}-${index}`}
                    className="align-top"
                  >
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                      {issue.rowNumber ?? 'file'}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <code className="text-navy-800">{issue.field}</code>
                    </td>
                    <td
                      className="max-w-[10rem] truncate px-2 py-1.5 text-slate-700"
                      title={issue.rawValue}
                    >
                      {issue.rawValue === '' ? (
                        <span className="text-slate-300">(empty)</span>
                      ) : (
                        issue.rawValue
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Badge tone={SEVERITY_TONE[issue.severity]}>
                        {issue.severity.toLowerCase()}
                      </Badge>
                      <span className="ml-1.5 text-slate-500">{issue.issueCode}</span>
                    </td>
                    <td className="px-2 py-1.5 text-slate-600">{issue.message}</td>
                    <td className="px-2 py-1.5 text-slate-600">
                      {issue.suggestedCorrection ?? <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-1.5 flex items-start gap-1.5 text-2xs leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Ambiguous values are never repaired silently. The raw cell is shown exactly as it was
          uploaded, and the downloadable error report on the Reports &amp; Exports screen carries
          the same rows for sign-off.
        </p>
      </section>

      <section className="rounded-lg border border-line p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Commit to a snapshot
        </h3>
        {batch.status === 'IMPORTED' ? (
          <p className="flex items-start gap-2 text-xs text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Committed {batch.committedAt ? formatDateTime(batch.committedAt) : ''} by{' '}
            {batch.committedBy ?? '—'} as snapshot{' '}
            <code className="mx-1">{batch.snapshotLabel ?? '—'}</code>. A snapshot is immutable: it
            is the input version every later calculation cites.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Snapshot label"
                value={snapshotLabel}
                placeholder={`Import ${batch.fileName}`}
                disabled={!can('import:commit') || inFlight || batch.status !== 'VALIDATED'}
                onChange={(event) => setSnapshotLabel(event.target.value)}
                hint="Optional, 3–120 characters. This label is what the run builder shows."
              />
              <label className="flex items-end gap-2 pb-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={skipDuplicates}
                  disabled={!can('import:commit') || inFlight || batch.status !== 'VALIDATED'}
                  onChange={(event) => setSkipDuplicates(event.target.checked)}
                />
                Skip exposure ids that already exist in this snapshot
              </label>
            </div>
            <Button
              className="mt-3"
              size="sm"
              icon={<FileUp className="h-3.5 w-3.5" />}
              loading={commit.isPending}
              disabled={!can('import:commit') || inFlight || batch.status !== 'VALIDATED'}
              onClick={() => commit.mutate()}
            >
              Commit {formatNumber(batch.validRowCount)} valid row(s)
            </Button>
            {batch.status !== 'VALIDATED' ? (
              <p className="mt-1.5 text-2xs text-slate-500">
                Only a <code>VALIDATED</code> batch can be committed — this one is{' '}
                <code>{batch.status}</code>.
                {!can('import:commit') ? ' Your role also cannot commit imports.' : ''}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ImportsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  // No filter fields: the service's `where` only honours `search`, which the hook
  // already owns. Anything else would be stripped by the query schema, so a
  // filter control here would look like it worked while doing nothing.
  const list = useServerList<Record<string, unknown>>({}, { sortBy: 'createdAt', sortDir: 'desc' });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['imports', list.query],
    queryFn: () => api.imports.list(list.query),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((batch) => isInFlight(batch.status)) ? 2000 : false,
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.imports.upload(file),
    onSuccess: (accepted) => {
      push(
        'success',
        'Upload received',
        `${accepted.record.fileName} — job ${accepted.jobId} on the ${accepted.driver} driver.`,
      );
      setOpenBatchId(accepted.record.publicId);
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (error) =>
      push('error', 'Upload rejected', messageOf(error, 'The file could not be processed.')),
  });

  const openBatch = data?.items.find((batch) => batch.publicId === openBatchId) ?? null;

  const columns = [
    column.accessor('fileName', {
      header: 'File',
      cell: (info) => (
        <div className="flex items-center gap-2">
          <FileUp className="h-4 w-4 shrink-0 text-slate-400" />
          <div className="min-w-0">
            <p className="truncate font-medium text-navy-800">{info.getValue()}</p>
            <p className="text-[10px] text-slate-400">
              <code>{info.row.original.publicId}</code> · {info.row.original.sourceFormat}
            </p>
          </div>
        </div>
      ),
    }),
    column.accessor('uploadedBy', { header: 'Uploaded by', enableSorting: false }),
    column.accessor('uploadedAt', {
      header: 'Uploaded',
      // The service whitelists the database column `createdAt`; `uploadedAt` is
      // the record's name for it, so sending it would be ignored and the header
      // arrow would silently do nothing.
      enableSorting: false,
      cell: (info) => (
        <span className="whitespace-nowrap text-slate-600">{formatDateTime(info.getValue())}</span>
      ),
    }),
    column.accessor('rowCount', {
      header: 'Rows',
      cell: (info) => <span className="tabular-nums">{formatNumber(info.getValue())}</span>,
    }),
    column.accessor('validRowCount', {
      header: 'Valid',
      enableSorting: false,
      cell: (info) => (
        <span className="tabular-nums text-emerald-700">{formatNumber(info.getValue())}</span>
      ),
    }),
    column.accessor('quarantinedRowCount', {
      header: 'Quarantined',
      enableSorting: false,
      cell: (info) =>
        info.getValue() > 0 ? (
          <span className="tabular-nums font-medium text-amber-700">{info.getValue()}</span>
        ) : (
          <span className="tabular-nums text-slate-300">0</span>
        ),
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (info) => (
        <Badge tone={STATUS_TONE[info.getValue()]}>{info.getValue().toLowerCase()}</Badge>
      ),
    }),
    column.accessor('message', {
      header: 'Result',
      enableSorting: false,
      cell: (info) => <span className="text-xs text-slate-500">{info.getValue()}</span>,
    }),
  ];

  return (
    <div>
      <PageHeader
        title="Data imports"
        description="Upload a CSV or XLSX portfolio, map its columns to the canonical 28-field dictionary, resolve or export the quarantined rows, then commit the valid ones into an immutable snapshot."
        tags={<SyntheticBadge />}
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void refetch()}
            >
              Refresh
            </Button>
            <Button
              data-tour="tour-imports-upload"
              size="sm"
              icon={<FileUp className="h-4 w-4" />}
              loading={upload.isPending}
              disabled={!can('import:upload')}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload file
            </Button>
          </>
        }
      />

      {!can('import:upload') ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Your role can read import history but cannot upload. Ask an admin or a risk analyst to run
          the ingestion.
        </p>
      ) : null}

      <Card data-tour="tour-imports-batches">
        <CardHeader
          title="Import history"
          description="Most recent first. Select a row to open the mapping, validation report and commit steps."
          actions={
            <div className="w-64">
              <Input
                aria-label="Search imports"
                placeholder="Search file, batch id or uploader…"
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
              data={data?.items ?? []}
              loading={isLoading}
              getRowId={(row) => row.publicId}
              onRowClick={(row) => setOpenBatchId(row.publicId)}
              manualSorting
              sorting={list.sortingState}
              onSortingChange={list.applySorting}
              emptyTitle="No imports yet"
              emptyDescription="Download a template from Reports & Exports, fill it in, and upload it here."
              emptyAction={
                can('import:upload') ? (
                  <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                    Upload file
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

      <Drawer
        open={openBatch !== null}
        onClose={() => setOpenBatchId(null)}
        title={openBatch ? openBatch.fileName : 'Import batch'}
        description={
          openBatch
            ? `${openBatch.publicId} · ${openBatch.status.toLowerCase()} · uploaded ${formatDateTime(openBatch.uploadedAt)}`
            : undefined
        }
      >
        {openBatchId ? <BatchWorkflow key={openBatchId} batchPublicId={openBatchId} /> : null}
      </Drawer>
    </div>
  );
}
