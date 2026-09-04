/**
 * Governance documents.
 *
 * Two halves of one feature with different requirements, and the page says which
 * half a deployment has rather than letting the user guess:
 *
 *   - **Indexing** is deterministic PostgreSQL work. A document is parsed,
 *     chunked and made citable with no model configured, so `INDEXED` is a real
 *     end state and retrieval answers work without an API key.
 *   - **Extraction** calls the model. Facts, proposed signals and the summary
 *     need a key, and without one the document stays indexed and the extract
 *     button explains why it will not do anything.
 *
 * A proposed risk signal is the one place this feature could have become a
 * financial input, so it is deliberately inert: accepting one writes a decision
 * and an audit event and nothing else. No exception is raised, no stage is
 * overridden, no exposure changes. The drawer says so, because a reviewer who
 * expects accepting a signal to do something downstream will otherwise wait for
 * it.
 *
 * Text inside an uploaded PDF is untrusted data. It is never executed as an
 * instruction, and the extraction it produces is screened server-side for
 * injection attempts before any of it reaches a model.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import {
  Check,
  FileText,
  Loader2,
  Quote,
  SearchX,
  Sparkles,
  ThumbsDown,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  DocumentCategory,
  DocumentProcessingStatus,
  DocumentRecord,
  DocumentSignalRecord,
} from '@eclens/shared';
import { DOCUMENT_CATEGORIES, DOCUMENT_PROCESSING_STATUSES, formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { AiAvailabilityNotice, AiCaveats, AiDisclaimer, AiLineList, AiProse } from '@/components/ai/AiChrome';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAiStatus } from '@/hooks/useAi';
import { useServerList } from '@/hooks/useServerList';
import { useAuth } from '@/providers/AuthProvider';
import {
  PROCESSING_STATUS_TONE,
  SEVERITY_TONE,
  SIGNAL_STATUS_TONE,
  categoryLabel,
  categoryShortLabel,
  processingStatusLabel,
  signalStatusLabel,
} from '@/lib/ai';
import { formatBytes } from '@/lib/utils';

const column = createColumnHelper<DocumentRecord>();

const PDF_MIME_TYPE = 'application/pdf';

/** The note floor the server enforces; checked here so the button is not a surprise. */
const MIN_DECISION_NOTE = 3;

type Decision = 'ACCEPTED' | 'REJECTED';

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * `verbatim` is the contract's answer to "did the model read this or invent it".
 *
 * A ratio the document never states is not extracted at all — the server refuses
 * it — so a fact marked non-verbatim is one the model assembled from figures that
 * *are* in the document, and the reviewer has to know the difference before
 * quoting it.
 */
function VerbatimBadge({ verbatim }: { verbatim: boolean }) {
  return verbatim ? (
    <Badge tone="positive">verbatim</Badge>
  ) : (
    <Badge tone="warning">derived · not written in the document</Badge>
  );
}

function PageRef({ page, chunkOrdinal }: { page?: number | null; chunkOrdinal?: number }) {
  if (!page && chunkOrdinal == null) return null;
  return (
    <span className="font-mono text-[11px] text-slate-400">
      {page ? `p. ${page}` : 'no page number'}
      {chunkOrdinal != null ? ` · chunk ${chunkOrdinal}` : ''}
    </span>
  );
}

function SignalCard({
  signal,
  canDecide,
  onDecide,
}: {
  signal: DocumentSignalRecord;
  canDecide: boolean;
  onDecide: (decision: Decision) => void;
}) {
  return (
    <li className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[signal.severity]}>{signal.severity.toLowerCase()}</Badge>
        <span className="text-xs font-medium text-navy-900">{signal.title}</span>
        <PageRef page={signal.page} />
        <code className="ml-auto font-mono text-[10px] text-slate-400">{signal.code}</code>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{signal.detail}</p>
      {/*
        The supporting text is shown in full, not summarised: it is the evidence
        for the proposal, and a signal the reviewer cannot check against the
        document is a signal they are being asked to take on trust.
      */}
      <p className="mt-1.5 flex items-start gap-1.5 border-l-2 border-slate-200 pl-2 text-[11px] italic leading-relaxed text-slate-500">
        <Quote className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{signal.supportingText}</span>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge tone={SIGNAL_STATUS_TONE[signal.status]}>{signalStatusLabel(signal.status)}</Badge>
        {signal.status === 'PROPOSED' ? (
          canDecide ? (
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => onDecide('ACCEPTED')}>
                Accept
              </Button>
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => onDecide('REJECTED')}>
                Reject
              </Button>
            </span>
          ) : (
            <span className="ml-auto text-[11px] text-slate-400">Your role cannot decide this</span>
          )
        ) : (
          <span className="ml-auto text-[11px] text-slate-500">
            {signal.decidedBy} · {formatDateTime(signal.decidedAt ?? '')}
          </span>
        )}
      </div>

      {signal.status !== 'PROPOSED' && signal.decisionNote ? (
        <p className="mt-1.5 rounded bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-500">Note: </span>
          {signal.decisionNote}
        </p>
      ) : null}
    </li>
  );
}

export function DocumentsPage() {
  const { can } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const ai = useAiStatus();

  const canWrite = can('document:write');
  const canDelete = can('document:delete');

  const list = useServerList<{ category?: DocumentCategory; processingStatus?: DocumentProcessingStatus }>(
    {},
    { sortBy: 'uploadedAt', pageSize: 25 },
  );

  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<DocumentCategory>('POLICY');
  const [displayName, setDisplayName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const [pendingDecision, setPendingDecision] = useState<{
    documentPublicId: string;
    signal: DocumentSignalRecord;
    decision: Decision;
  } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');

  // `?doc=<publicId>` is what a citation chip links to, so the deep link and the
  // row click drive the same state rather than two drawers that can disagree.
  const selectedId = searchParams.get('doc');

  const documents = useQuery({
    queryKey: ['documents', list.query],
    queryFn: () => api.documents.list(list.query),
  });

  const document = useQuery({
    queryKey: ['document', selectedId],
    queryFn: () => api.documents.get(selectedId as string),
    enabled: Boolean(selectedId),
  });

  const open = (publicId: string) => setSearchParams({ doc: publicId }, { replace: true });
  const close = () => {
    setSearchParams({}, { replace: true });
    setPendingDecision(null);
  };

  const availability = documents.data?.availability;
  /** The server's own configured limit, so the form and the API never disagree. */
  const maxBytes = ai.limits?.maxDocumentBytes;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
    if (selectedId) void queryClient.invalidateQueries({ queryKey: ['document', selectedId] });
  };

  const upload = useMutation({
    mutationFn: () =>
      api.documents.upload(file as File, {
        category,
        ...(displayName.trim() ? { name: displayName.trim() } : {}),
      }),
    onSuccess: (response) => {
      push(
        'success',
        response.duplicateOf ? 'Already in the library' : 'Document uploaded',
        response.duplicateOf
          ? `A byte-identical document is already stored as ${response.duplicateOf}. This copy is indexed too, so two citations may point at the same file.`
          : `${response.document.name} is ${processingStatusLabel(response.document.processingStatus)}.`,
      );
      setUploadOpen(false);
      setFile(null);
      setDisplayName('');
      setFileError(null);
      invalidate();
      open(response.document.publicId);
    },
    onError: (error: unknown) => {
      // The server's own wording: it distinguishes an unsupported type, an
      // oversized file and a parse failure, and each needs a different fix.
      setFileError(messageOf(error, 'The document could not be uploaded.'));
      push('error', 'Upload rejected', messageOf(error, 'The document could not be uploaded.'));
    },
  });

  const extract = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.documents.extract(id, force),
    onSuccess: (response) => {
      invalidate();
      // A null result is not an exception — the envelope carries a failed or
      // unavailable extraction as a 200 with the reason in `message`, and that
      // reason is what the reviewer needs, verbatim.
      if (response.result) {
        push(
          'success',
          'Document extracted',
          `${response.result.extractedFacts.length} fact${response.result.extractedFacts.length === 1 ? '' : 's'} and ${response.result.proposedRiskSignals.length} proposed signal${response.result.proposedRiskSignals.length === 1 ? '' : 's'}. Each signal needs your decision.`,
        );
      } else {
        push('error', 'Nothing was extracted', response.message);
      }
    },
    onError: (error: unknown) => {
      push('error', 'Extraction request refused', messageOf(error, 'The request did not reach the server.'));
    },
  });

  /** The refused extraction, when one was refused, for the drawer body. */
  const extractRefusal = extract.data && extract.data.result === null ? extract.data : null;

  const remove = useMutation({
    mutationFn: (target: DocumentRecord) => api.documents.remove(target.publicId),
    onSuccess: (_result, target) => {
      push('success', 'Document deleted', `${target.name} is no longer searchable and its citations no longer resolve.`);
      setPendingDelete(null);
      if (selectedId === target.publicId) close();
      invalidate();
    },
    onError: (error: unknown) => {
      setPendingDelete(null);
      push('error', 'Delete rejected', messageOf(error, 'The document could not be deleted.'));
    },
  });

  const decide = useMutation({
    mutationFn: ({
      documentPublicId,
      signal,
      decision,
      note,
    }: {
      documentPublicId: string;
      signal: DocumentSignalRecord;
      decision: Decision;
      note: string;
    }) => api.documents.decideSignal(documentPublicId, signal.id, { decision, note: note.trim() }),
    onSuccess: (updated, variables) => {
      push(
        'success',
        variables.decision === 'ACCEPTED' ? 'Signal accepted' : 'Signal rejected',
        `${updated.title}. The decision and your note are in the audit trail; no exposure, stage or exception changed.`,
      );
      setPendingDecision(null);
      setDecisionNote('');
      invalidate();
    },
    onError: (error: unknown) => {
      setPendingDecision(null);
      push('error', 'Decision not recorded', messageOf(error, 'The decision could not be recorded.'));
      invalidate();
    },
  });

  const pickFile = (picked: File | null) => {
    setFileError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    if (picked.type !== PDF_MIME_TYPE && !picked.name.toLowerCase().endsWith('.pdf')) {
      setFile(picked);
      setFileError(
        'Only PDF documents are accepted here. Spreadsheet data belongs in the portfolio import, where it is parsed and validated column by column.',
      );
      return;
    }
    // Checked here as well as on the server so an oversized file is refused before
    // it is uploaded, not after. The server's signature and size checks are still
    // the authoritative ones — this only saves the wait.
    if (maxBytes !== undefined && picked.size > maxBytes) {
      setFile(picked);
      setFileError(
        `${picked.name} is ${formatBytes(picked.size)}, over the ${formatBytes(maxBytes)} limit for AI documents.`,
      );
      return;
    }
    setFile(picked);
  };

  const columns = [
    column.accessor('name', {
      header: 'Document',
      cell: (info) => {
        const row = info.row.original;
        return (
          <div className="max-w-sm">
            <p className="truncate font-medium text-slate-800">{info.getValue()}</p>
            <p className="truncate text-[11px] text-slate-500">
              {row.documentType ?? row.mimeType}
              {row.seeded ? ' · seeded governance library' : ''}
            </p>
          </div>
        );
      },
    }),
    column.accessor('category', {
      header: 'Category',
      cell: (info) => <Badge tone="neutral">{categoryShortLabel(info.getValue())}</Badge>,
    }),
    column.accessor('processingStatus', {
      header: 'Status',
      cell: (info) => {
        const status = info.getValue();
        return (
          <span className="flex items-center gap-1.5">
            <Badge tone={PROCESSING_STATUS_TONE[status]}>{processingStatusLabel(status)}</Badge>
            {status === 'QUEUED' || status === 'PARSING' ? (
              <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
            ) : null}
          </span>
        );
      },
    }),
    column.accessor('signals', {
      header: 'Signals',
      cell: (info) => {
        const signals = info.getValue();
        const proposed = signals.filter((signal) => signal.status === 'PROPOSED').length;
        if (signals.length === 0) return <span className="text-[11px] text-slate-400">none</span>;
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <span className="tabular-nums">{signals.length}</span>
            {proposed > 0 ? <Badge tone="warning">{proposed} awaiting decision</Badge> : null}
          </span>
        );
      },
    }),
    column.accessor('sizeBytes', {
      header: 'Size',
      cell: (info) => <span className="tabular-nums text-xs text-slate-600">{formatBytes(info.getValue())}</span>,
    }),
    column.accessor('uploadedAt', {
      header: 'Uploaded',
      cell: (info) => (
        <div>
          <p className="tabular-nums text-xs text-slate-500">{formatDateTime(info.getValue())}</p>
          <p className="text-[11px] text-slate-400">{info.row.original.uploadedBy}</p>
        </div>
      ),
    }),
    column.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const row = info.row.original;
        if (!canDelete) return null;
        return (
          <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setPendingDelete(row)}
            >
              Delete
            </Button>
          </span>
        );
      },
    }),
  ];

  const rows = documents.data?.items ?? [];
  const selected = document.data;
  const extraction = selected?.extraction ?? null;
  const noteValid = decisionNote.trim().length >= MIN_DECISION_NOTE;

  return (
    <div>
      <PageHeader
        title="Governance documents"
        description="PDFs the copilot and the document features may quote from. Every document is chunked and citable with page references; extraction adds facts and proposed risk signals for a person to accept or reject."
        tags={
          availability ? (
            availability.available ? (
              <Badge tone="positive">extraction available · {availability.model}</Badge>
            ) : (
              <Badge tone="neutral">indexing only · {availability.reason.replace(/_/g, ' ').toLowerCase()}</Badge>
            )
          ) : undefined
        }
        actions={
          canWrite ? (
            <Button icon={<Upload className="h-4 w-4" />} onClick={() => setUploadOpen(true)}>
              Upload PDF
            </Button>
          ) : undefined
        }
      />

      {availability && !availability.available ? (
        <div className="mb-4">
          <AiAvailabilityNotice availability={availability}>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              Documents already stored stay indexed and citable, and the copilot can still quote from them. What is
              unavailable is extraction: no new facts or proposed signals can be produced until a model is configured.
            </p>
          </AiAvailabilityNotice>
        </div>
      ) : null}

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_220px_200px]">
          <Input
            aria-label="Search documents"
            placeholder="Search document name or type…"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
          />
          <Select
            aria-label="Filter by category"
            value={list.filters.category ?? ''}
            onChange={(event) =>
              list.setFilter('category', event.target.value === '' ? undefined : (event.target.value as DocumentCategory))
            }
          >
            <option value="">All categories</option>
            {DOCUMENT_CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>
                {categoryShortLabel(entry)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by processing status"
            value={list.filters.processingStatus ?? ''}
            onChange={(event) =>
              list.setFilter(
                'processingStatus',
                event.target.value === '' ? undefined : (event.target.value as DocumentProcessingStatus),
              )
            }
          >
            <option value="">All statuses</option>
            {DOCUMENT_PROCESSING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {processingStatusLabel(status)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Library"
          description={
            documents.data
              ? `${documents.data.meta.totalItems} document${documents.data.meta.totalItems === 1 ? '' : 's'} in this organisation`
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
        {documents.isError ? (
          <ErrorState onRetry={() => void documents.refetch()} />
        ) : !documents.isLoading && rows.length === 0 && list.hasActiveFilters ? (
          <EmptyState
            icon={<SearchX className="h-8 w-8" />}
            title="No documents match your filters"
            description="Widen the category or status filter, or clear the search."
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
            loading={documents.isLoading}
            getRowId={(row) => row.publicId}
            onRowClick={(row) => open(row.publicId)}
            emptyTitle="No documents stored yet"
            emptyDescription="Upload a credit policy, a borrower's audited financials or external guidance to give the copilot something citable to read."
            emptyAction={
              canWrite ? (
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  Upload a PDF
                </Button>
              ) : undefined
            }
          />
        )}
        {documents.data ? <Pagination meta={documents.data.meta} onPageChange={list.setPage} loading={documents.isLoading} /> : null}
      </Card>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Uploaded text is treated as data, never as instructions: it cannot change the system policy, cannot call an
        application action, and is screened for injection attempts before a model sees it. Full text of copyrighted
        standards is not bundled — upload your own licensed copy if you need it cited.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Detail drawer                                                       */}
      {/* ------------------------------------------------------------------ */}

      <Drawer
        open={Boolean(selectedId)}
        onClose={close}
        title={selected?.name ?? 'Document'}
        description={
          selected
            ? `${categoryShortLabel(selected.category)} · ${formatBytes(selected.sizeBytes)} · uploaded by ${selected.uploadedBy} on ${formatDateTime(selected.uploadedAt)}`
            : undefined
        }
        footer={
          selected ? (
            <span className="flex w-full items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-slate-400">{selected.publicId}</span>
              <span className="flex gap-2">
                {canWrite && selected.processingStatus !== 'UNSUPPORTED' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    loading={extract.isPending}
                    onClick={() => extract.mutate({ id: selected.publicId, force: Boolean(extraction) })}
                  >
                    {extraction ? 'Re-extract' : 'Extract facts and signals'}
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => setPendingDelete(selected)}
                  >
                    Delete
                  </Button>
                ) : null}
              </span>
            </span>
          ) : undefined
        }
      >
        {document.isError ? (
          <ErrorState
            title="This document could not be opened"
            description={messageOf(document.error, 'It may have been deleted, or it belongs to another organisation.')}
            onRetry={() => void document.refetch()}
          />
        ) : !selected ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={PROCESSING_STATUS_TONE[selected.processingStatus]}>
                {processingStatusLabel(selected.processingStatus)}
              </Badge>
              {selected.seeded ? <Badge tone="info">seeded governance library</Badge> : null}
              <Badge tone="neutral">
                {selected.pageCount == null ? 'no page count' : `${selected.pageCount} pages`}
              </Badge>
              <Badge tone="neutral">{selected.chunkCount} chunks</Badge>
            </div>

            {selected.message ? (
              <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                {selected.message}
              </p>
            ) : null}

            {extract.isPending ? (
              <p className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-navy-500" />
                Reading the document and checking every extracted figure against the text it came from…
              </p>
            ) : null}
            {extractRefusal ? (
              extractRefusal.status === 'UNAVAILABLE' ? (
                <AiAvailabilityNotice availability={extractRefusal.availability} />
              ) : (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
                  {extractRefusal.message}
                  {extractRefusal.aiRequestId ? (
                    <span className="mt-1 block font-mono text-[11px] text-red-500">
                      AI request {extractRefusal.aiRequestId}
                    </span>
                  ) : null}
                </p>
              )
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
              <div>
                <p className="uppercase tracking-wider text-slate-400">MIME type</p>
                <p className="mt-0.5 font-mono text-slate-600">{selected.mimeType}</p>
              </div>
              <div>
                <p className="uppercase tracking-wider text-slate-400">SHA-256</p>
                <p className="mt-0.5 truncate font-mono text-slate-600" title={selected.sha256}>
                  {selected.sha256}
                </p>
              </div>
            </div>

            {extraction ? (
              <>
                <div className="border-t border-slate-200 pt-3">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <FileText className="h-4 w-4 text-slate-400" />
                    <span className="text-sm font-medium text-slate-800">{extraction.documentType}</span>
                    <Badge tone="warning">approval required</Badge>
                  </div>
                  <AiProse title="Summary" body={extraction.summary} />
                </div>

                {extraction.extractedFacts.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Extracted facts ({extraction.extractedFacts.length})
                    </p>
                    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                      {extraction.extractedFacts.map((fact, index) => (
                        <li key={`${fact.label}-${index}`} className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-slate-700">{fact.label}</span>
                            <PageRef page={fact.page} />
                            <span className="ml-auto">
                              <VerbatimBadge verbatim={fact.verbatim} />
                            </span>
                          </div>
                          <p className="mt-0.5 font-mono text-xs text-navy-900">{fact.value}</p>
                          {fact.asOf ? <p className="mt-0.5 text-[11px] text-slate-500">as of {fact.asOf}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {extraction.citations.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Citations ({extraction.citations.length})
                    </p>
                    <ul className="space-y-1.5">
                      {extraction.citations.map((citation, index) => (
                        <li key={`${citation.page ?? 0}-${index}`} className="rounded-md bg-slate-50 px-3 py-2">
                          <p className="text-[11px] italic leading-relaxed text-slate-600">“{citation.quote}”</p>
                          <p className="mt-1 flex flex-wrap items-center gap-1.5">
                            <PageRef page={citation.page} chunkOrdinal={citation.chunkOrdinal} />
                            <span className="text-[11px] text-slate-400">{citation.documentName}</span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <AiLineList title="Missing information" items={extraction.missingInformation} />
                <AiCaveats title="Warnings" items={extraction.warnings} />
              </>
            ) : (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
                {selected.processingStatus === 'INDEXED'
                  ? 'Indexed and citable, but not yet extracted. Extraction needs a model; run it to get facts, citations and proposed risk signals.'
                  : selected.processingStatus === 'FAILED' || selected.processingStatus === 'UNSUPPORTED'
                    ? 'This document could not be processed, so there is nothing to extract from it. The message above says why.'
                    : 'Processing has not finished yet. Reload once the status above reads indexed.'}
              </p>
            )}

            {selected.signals.length > 0 ? (
              <div className="border-t border-slate-200 pt-3">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Proposed risk signals ({selected.signals.length})
                </p>
                <ul className="space-y-2">
                  {selected.signals.map((signal) => (
                    <SignalCard
                      key={signal.id}
                      signal={signal}
                      canDecide={canWrite}
                      onDecide={(decision) => {
                        setDecisionNote('');
                        setPendingDecision({ documentPublicId: selected.publicId, signal, decision });
                      }}
                    />
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Deciding a signal records your decision, your note and your name in the audit trail. It does not raise
                  an exception, override a stage, or change an exposure — those stay on their own permissioned paths.
                </p>
              </div>
            ) : null}

            <AiDisclaimer />
          </div>
        )}
      </Drawer>

      {/* ------------------------------------------------------------------ */}
      {/* Upload                                                              */}
      {/* ------------------------------------------------------------------ */}

      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload a governance document"
        description="PDF only. The file is parsed, chunked and indexed for citation; nothing in it is executed as an instruction."
        footer={
          <span className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setUploadOpen(false)} disabled={upload.isPending}>
              Cancel
            </Button>
            <Button
              icon={<Upload className="h-4 w-4" />}
              loading={upload.isPending}
              disabled={!file || Boolean(fileError)}
              onClick={() => upload.mutate()}
            >
              Upload
            </Button>
          </span>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">PDF file</span>
            <input
              type="file"
              accept={PDF_MIME_TYPE}
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              className="mt-1.5 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
            />
          </label>
          {file ? (
            <p className="text-[11px] text-slate-500">
              {file.name} · {formatBytes(file.size)}
              {maxBytes ? ` · limit ${formatBytes(maxBytes)}` : ''}
            </p>
          ) : null}

          <Select
            label="Category"
            hint="Decides which questions this document is searched to answer."
            value={category}
            onChange={(event) => setCategory(event.target.value as DocumentCategory)}
          >
            {DOCUMENT_CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>
                {categoryLabel(entry)}
              </option>
            ))}
          </Select>

          <Input
            label="Display name"
            hint="Optional. The sanitized filename is used when this is left blank."
            value={displayName}
            maxLength={160}
            placeholder="Credit Policy 2026 — ECL and staging"
            onChange={(event) => setDisplayName(event.target.value)}
          />

          {fileError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700" role="alert">
              {fileError}
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-slate-500">
              A byte-identical file that is already stored is reported rather than silently deduplicated, so you will
              know when two citations point at the same document.
            </p>
          )}
        </div>
      </Modal>

      {/* ------------------------------------------------------------------ */}
      {/* Signal decision                                                     */}
      {/* ------------------------------------------------------------------ */}

      <Modal
        open={pendingDecision !== null}
        onClose={() => setPendingDecision(null)}
        size="sm"
        title={pendingDecision?.decision === 'ACCEPTED' ? 'Accept proposed signal' : 'Reject proposed signal'}
        description={pendingDecision?.signal.title}
        footer={
          <span className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingDecision(null)} disabled={decide.isPending}>
              Cancel
            </Button>
            <Button
              variant={pendingDecision?.decision === 'ACCEPTED' ? 'primary' : 'danger'}
              icon={pendingDecision?.decision === 'ACCEPTED' ? <Check className="h-4 w-4" /> : <ThumbsDown className="h-4 w-4" />}
              loading={decide.isPending}
              disabled={!noteValid}
              onClick={() =>
                pendingDecision
                  ? decide.mutate({
                      documentPublicId: pendingDecision.documentPublicId,
                      signal: pendingDecision.signal,
                      decision: pendingDecision.decision,
                      note: decisionNote,
                    })
                  : undefined
              }
            >
              {pendingDecision?.decision === 'ACCEPTED' ? 'Accept' : 'Reject'}
            </Button>
          </span>
        }
      >
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-600" htmlFor="signal-note">
            Note for the audit trail (required)
          </label>
          <textarea
            id="signal-note"
            rows={4}
            maxLength={1000}
            value={decisionNote}
            onChange={(event) => setDecisionNote(event.target.value)}
            placeholder={
              pendingDecision?.decision === 'ACCEPTED'
                ? 'What did you verify against the document, and what happens next?'
                : 'Why is this signal not a finding — misread text, superseded document, or already handled?'
            }
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-navy-400 focus:outline-none focus:ring-2 focus:ring-navy-100"
          />
          <p className="text-[11px] text-slate-500">
            {noteValid
              ? 'Recorded with your name against this signal. A decision is one-way: it cannot be changed afterwards.'
              : `At least ${MIN_DECISION_NOTE} characters — the server requires a note, so the decision is never recorded without a reason.`}
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this document?"
        description={
          pendingDelete
            ? `${pendingDelete.name} will be removed from the retrieval library. Citations already given in earlier AI answers will no longer resolve to it, and any proposed signals still awaiting a decision are deleted with it. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete document"
        destructive
        loading={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => (pendingDelete ? remove.mutate(pendingDelete) : undefined)}
      />
    </div>
  );
}
