/**
 * Reports & exports (acceptance criterion 1, implementation task 13).
 *
 * Three permissioned, audited downloads: a per-run PDF report
 * (`REPORT.GENERATED`, `GET /ecl-runs/:id/report`), the synthetic portfolio
 * template (`TEMPLATE.DOWNLOADED`), and one import batch's error report
 * (`IMPORT.ISSUES_EXPORTED`) — all gated on `report:export`.
 *
 * The field guide is rendered next to the template download on purpose: the
 * endpoint returns it alongside the bytes, and "download a template" is only
 * half useful without the column documentation that says what each field means.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ClipboardCheck, FileDown, FileSpreadsheet, Info, ScrollText } from 'lucide-react';
import type { EclRunSummaryRecord, ImportBatchRecord, RunStatus, TemplateDownloadRecord } from '@eclens/shared';
import { formatDate, formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError, saveBase64File, saveTextFile } from '@/api/http';
import { Badge, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/providers/AuthProvider';

const TEMPLATE_COUNT_MIN = 50;
const TEMPLATE_COUNT_MAX = 5000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Only batches that actually produced issues are worth an error report. */
const hasIssues = (batch: ImportBatchRecord): boolean => batch.errorCount > 0 || batch.warningCount > 0;

/** Runs with persisted results — the only ones a PDF report can be generated for. */
const REPORTABLE_STATUSES: RunStatus[] = ['COMPLETED', 'SUBMITTED', 'APPROVED', 'REJECTED'];

export function ReportsPage() {
  const { can } = useAuth();
  const { push } = useToast();

  const [kind, setKind] = useState<'blank' | 'sample'>('sample');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [count, setCount] = useState('750');
  const [reportingDate, setReportingDate] = useState('');
  const [fieldGuide, setFieldGuide] = useState<TemplateDownloadRecord['fieldGuide'] | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState('');

  const canExport = can('report:export');

  const { data: batches, isLoading: batchesLoading } = useQuery({
    queryKey: ['import-batches-for-export'],
    // No `sortBy`: the service default is the only ordering guaranteed to be in
    // its whitelist, and this list is a picker rather than a data grid.
    queryFn: () => api.imports.list({ page: 1, pageSize: 50, sortDir: 'desc' }),
  });
  const exportable = (batches?.items ?? []).filter(hasIssues);
  const selectedBatch = exportable.find((batch) => batch.publicId === selectedBatchId) ?? null;

  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: ['runs-for-report'],
    queryFn: () => api.runs.list({ page: 1, pageSize: 50, sortDir: 'desc' }),
  });
  const reportable = (runs?.items ?? []).filter((run) => REPORTABLE_STATUSES.includes(run.status));
  const [selectedRunId, setSelectedRunId] = useState('');
  const selectedRun = reportable.find((run: EclRunSummaryRecord) => run.publicId === selectedRunId) ?? null;

  const runReport = useMutation({
    mutationFn: (runPublicId: string) => api.runs.report(runPublicId),
    onSuccess: (download) => {
      saveBase64File(download.fileName, download.contentBase64, download.contentType);
      push('success', 'Report downloaded', `${download.fileName}. Recorded in the audit log.`);
    },
    onError: (error) => {
      push('error', 'Report generation failed', error instanceof ApiError ? error.message : 'The report could not be generated.');
    },
  });

  const template = useMutation({
    mutationFn: () =>
      api.templates.portfolio({
        kind,
        format,
        ...(kind === 'sample' ? { count: Number(count) } : {}),
        ...(reportingDate.trim() === '' ? {} : { reportingDate: reportingDate.trim() }),
      }),
    onSuccess: (record) => {
      saveBase64File(record.fileName, record.contentBase64, record.contentType);
      setFieldGuide(record.fieldGuide);
      push(
        'success',
        'Template downloaded',
        `${record.fileName} — ${record.rowCount} data row(s). Recorded in the audit log.`,
      );
    },
    onError: (error) => {
      push(
        'error',
        'Download failed',
        error instanceof ApiError ? error.message : 'The template could not be generated.',
      );
    },
  });

  const errorReport = useMutation({
    mutationFn: (batchPublicId: string) => api.imports.issuesCsv(batchPublicId),
    onSuccess: (csv, batchPublicId) => {
      saveTextFile(`import-${batchPublicId}-issues.csv`, csv, 'text/csv;charset=utf-8');
      push('success', 'Error report exported', 'The quarantined rows are in the CSV. Recorded in the audit log.');
    },
    onError: (error) => {
      push(
        'error',
        'Export failed',
        error instanceof ApiError ? error.message : 'The error report could not be exported.',
      );
    },
  });

  const countValue = Number(count);
  const templateValid =
    kind === 'blank' ||
    (Number.isInteger(countValue) && countValue >= TEMPLATE_COUNT_MIN && countValue <= TEMPLATE_COUNT_MAX);
  const reportingDateValid = reportingDate.trim() === '' || ISO_DATE.test(reportingDate.trim());

  return (
    <div>
      <PageHeader
        title="Reports & Exports"
        description="Every download here is permissioned and written to the immutable audit trail: an approved-run PDF report, the synthetic portfolio template, and an import batch's error report."
        tags={<SyntheticBadge />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ClipboardCheck className="h-4 w-4 text-navy-700" />
                Approved run reports
              </span>
            }
            description="GET /ecl-runs/:id/report — audited as REPORT.GENERATED"
          />
          <CardContent className="space-y-4">
            {runsLoading ? (
              <Skeleton className="h-24" />
            ) : reportable.length === 0 ? (
              <EmptyState
                icon={<ClipboardCheck className="h-8 w-8" />}
                title="No run has results yet"
                description="Execute an ECL run from the ECL Runs screen and a report can be generated for it here."
              />
            ) : (
              <>
                <Select
                  label="Run"
                  value={selectedRunId}
                  onChange={(event) => setSelectedRunId(event.target.value)}
                  hint="Only runs that completed calculation are listed. Unapproved runs are watermarked in the PDF."
                >
                  <option value="">Select a run…</option>
                  {reportable.map((run) => (
                    <option key={run.publicId} value={run.publicId}>
                      {run.publicId} — {formatDate(run.runDate)} — {run.status.toLowerCase()}
                    </option>
                  ))}
                </Select>
                {selectedRun ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md bg-slate-50 px-3 py-2.5 text-xs">
                    <div>
                      <dt className="text-slate-500">Status</dt>
                      <dd className="font-medium text-slate-800">
                        <Badge tone={selectedRun.status === 'APPROVED' ? 'positive' : 'warning'}>
                          {selectedRun.status.toLowerCase()}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Completed</dt>
                      <dd className="font-medium text-slate-800">
                        {selectedRun.completedAt ? formatDateTime(selectedRun.completedAt) : '—'}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <Button
                  icon={<FileDown className="h-4 w-4" />}
                  loading={runReport.isPending}
                  disabled={selectedRun === null}
                  onClick={() => selectedRun && runReport.mutate(selectedRun.publicId)}
                >
                  Generate PDF report
                </Button>
              </>
            )}
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The report includes totals, stage breakdown, scenario weights, movement since the prior period,
              concentration, model assumptions and approval history — every figure copied from the run's own
              persisted record. A run that is not yet approved is clearly watermarked as a draft.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-navy-700" />
                Portfolio template
              </span>
            }
            description="GET /templates/portfolio — audited as TEMPLATE.DOWNLOADED"
          />
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Contents"
                value={kind}
                onChange={(event) => setKind(event.target.value as 'blank' | 'sample')}
                hint="A sample is a full synthetic portfolio; a blank is headers only."
              >
                <option value="sample">Sample portfolio (synthetic)</option>
                <option value="blank">Blank template</option>
              </Select>
              <Select
                label="Format"
                value={format}
                onChange={(event) => setFormat(event.target.value as 'csv' | 'xlsx')}
              >
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
              </Select>
              {kind === 'sample' ? (
                <Input
                  label="Rows"
                  type="number"
                  min={TEMPLATE_COUNT_MIN}
                  max={TEMPLATE_COUNT_MAX}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  error={templateValid ? undefined : `Between ${TEMPLATE_COUNT_MIN} and ${TEMPLATE_COUNT_MAX}.`}
                  hint="The generator is deterministic: the same date and row count reproduce byte-identical output."
                />
              ) : null}
              <Input
                label="Reporting date"
                type="date"
                value={reportingDate}
                onChange={(event) => setReportingDate(event.target.value)}
                error={reportingDateValid ? undefined : 'Use YYYY-MM-DD.'}
                hint="Optional. Anchors maturity dates so the sample stays internally consistent."
              />
            </div>

            <Button
              icon={<FileDown className="h-4 w-4" />}
              loading={template.isPending}
              disabled={!templateValid || !reportingDateValid}
              onClick={() => template.mutate()}
            >
              Download template
            </Button>

            {fieldGuide ? (
              <div className="border-t border-slate-100 pt-3">
                <p className="mb-2 text-xs font-medium text-slate-600">
                  Field guide — {fieldGuide.length} columns
                </p>
                <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-medium">Column</th>
                        <th className="px-2.5 py-1.5 font-medium">Type</th>
                        <th className="px-2.5 py-1.5 font-medium">Meaning</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {fieldGuide.map((field) => (
                        <tr key={field.key} className="align-top">
                          <td className="whitespace-nowrap px-2.5 py-1.5">
                            <code className="text-[11px] text-navy-800">{field.key}</code>
                            {field.required ? <Badge tone="warning">required</Badge> : null}
                            <span className="ml-1.5 block text-slate-500">{field.label}</span>
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-500">{field.kind}</td>
                          <td className="px-2.5 py-1.5 text-slate-600">{field.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Import error report
              </span>
            }
            description="GET /imports/:id/issues/export — audited as IMPORT.ISSUES_EXPORTED"
          />
          <CardContent className="space-y-4">
            {!canExport ? (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Your role does not carry <code className="mx-1">report:export</code>. The error report is still
                readable on the Imports screen — only the CSV download is restricted.
              </p>
            ) : null}

            {batchesLoading ? (
              <Skeleton className="h-24" />
            ) : exportable.length === 0 ? (
              <EmptyState
                icon={<AlertTriangle className="h-8 w-8" />}
                title="No import issues to export"
                description="Upload a portfolio with invalid rows and the quarantined records will be listed here."
              />
            ) : (
              <>
                <Select
                  label="Import batch"
                  value={selectedBatchId}
                  onChange={(event) => setSelectedBatchId(event.target.value)}
                  hint="Only batches that produced errors or warnings are listed."
                >
                  <option value="">Select a batch…</option>
                  {exportable.map((batch) => (
                    <option key={batch.publicId} value={batch.publicId}>
                      {batch.fileName} — {batch.errorCount} error(s), {batch.warningCount} warning(s)
                    </option>
                  ))}
                </Select>

                {selectedBatch ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md bg-slate-50 px-3 py-2.5 text-xs">
                    <div>
                      <dt className="text-slate-500">Batch</dt>
                      <dd className="font-medium text-slate-800">
                        <code>{selectedBatch.publicId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Uploaded</dt>
                      <dd className="font-medium text-slate-800">{formatDateTime(selectedBatch.uploadedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Quarantined rows</dt>
                      <dd className="tabular-nums font-medium text-slate-800">{selectedBatch.quarantinedRowCount}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Valid rows</dt>
                      <dd className="tabular-nums font-medium text-slate-800">{selectedBatch.validRowCount}</dd>
                    </div>
                  </dl>
                ) : null}

                <Button
                  variant="secondary"
                  icon={<FileDown className="h-4 w-4" />}
                  loading={errorReport.isPending}
                  disabled={selectedBatch === null}
                  onClick={() => selectedBatch && errorReport.mutate(selectedBatch.publicId)}
                >
                  Export error report (CSV)
                </Button>
              </>
            )}

            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The report carries one row per validation issue: row number, field, the raw value exactly as it was
              uploaded, the issue code, severity and a suggested correction. Ambiguous values are never silently
              repaired, so the file is the record of what was rejected and why.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
