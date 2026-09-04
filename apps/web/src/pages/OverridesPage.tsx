import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ArrowRight, GitCompareArrows, SearchX } from 'lucide-react';
import type { RoleName, StageOverrideListItem } from '@eclens/shared';
import { formatDateTime } from '@eclens/shared';
import { ApiError } from '@/api/http';
import { api } from '@/api/client';
import { Badge, StageBadge, type BadgeTone } from '@/components/ui/Badge';
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

const column = createColumnHelper<StageOverrideListItem>();

type ReviewerStatus = 'PENDING_REVIEW' | 'REVIEWED' | 'REJECTED';

const STATUS_TONE: Record<ReviewerStatus, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  REVIEWED: 'positive',
  REJECTED: 'danger',
};

const ROLE_LABEL: Record<RoleName, string> = {
  ADMIN: 'Admin',
  RISK_ANALYST: 'Risk Analyst',
  REVIEWER: 'Reviewer',
  AUDITOR: 'Auditor',
};

/**
 * The four-eyes review surface for analyst stage overrides.
 *
 * An override is live the moment it is requested, so this queue is where a
 * second person confirms or rolls it back. The server refuses to let the actor
 * review their own override (`OVERRIDE_SELF_REVIEW_PROHIBITED`); the button is
 * hidden here for the same case so the refusal is never a surprise.
 */
export function OverridesPage() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { user, can } = useAuth();
  const canReview = can('override:review');

  const list = useServerList<{ status?: ReviewerStatus }>(
    {},
    { sortBy: 'occurredAt', sortDir: 'desc' },
  );

  const [selected, setSelected] = useState<StageOverrideListItem | null>(null);
  const [review, setReview] = useState<{
    item: StageOverrideListItem;
    decision: 'REVIEWED' | 'REJECTED';
  } | null>(null);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['stage-overrides', list.query],
    queryFn: () => api.overrides.queue(list.query),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['stage-overrides'] });
    void queryClient.invalidateQueries({ queryKey: ['exceptions'] });
  };

  const reviewMutation = useMutation({
    mutationFn: ({
      item,
      decision,
      note,
    }: {
      item: StageOverrideListItem;
      decision: 'REVIEWED' | 'REJECTED';
      note: string;
    }) => api.overrides.review(item.id, { decision, comment: note }),
    onSuccess: (override, variables) => {
      push(
        variables.decision === 'REVIEWED' ? 'success' : 'info',
        variables.decision === 'REVIEWED' ? 'Override confirmed' : 'Override rejected',
        `Stage ${override.stageBefore} → ${override.stageAfter} on ${selected?.exposurePublicId ?? 'the exposure'}.`,
      );
      setReview(null);
      setComment('');
      setCommentError(null);
      setSelected(null);
      invalidate();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        // A 400 here is almost always the 3-character minimum on the comment.
        const fields = error.fieldMessages();
        const firstFieldError = Object.values(fields)[0];
        setCommentError(firstFieldError ?? null);
        push('error', 'Review rejected', firstFieldError ?? error.message);
        invalidate();
        return;
      }
      push('error', 'Review failed', 'The override could not be reviewed.');
    },
  });

  const openReview = (item: StageOverrideListItem, decision: 'REVIEWED' | 'REJECTED') => {
    setComment('');
    setCommentError(null);
    setReview({ item, decision });
  };

  const columns = [
    column.accessor('exposurePublicId', {
      header: 'Exposure',
      cell: (info) => (
        <div>
          <Link
            to={`/portfolio/${info.getValue()}`}
            className="font-medium text-navy-800 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {info.getValue()}
          </Link>
          <p className="text-2xs text-slate-500">
            {info.row.original.borrowerName} · {info.row.original.segment}
          </p>
        </div>
      ),
    }),
    column.accessor('stageBefore', {
      header: 'Change',
      cell: (info) => (
        <span className="flex items-center gap-1.5">
          <StageBadge stage={info.getValue()} />
          <ArrowRight className="h-3 w-3 text-slate-400" />
          <StageBadge stage={info.row.original.stageAfter} />
        </span>
      ),
    }),
    column.accessor('reason', {
      header: 'Reason',
      cell: (info) => (
        <span className="line-clamp-2 max-w-sm text-xs text-slate-600">{info.getValue()}</span>
      ),
    }),
    column.accessor('actorName', {
      header: 'Requested by',
      cell: (info) => (
        <div>
          <p className="text-slate-700">{info.getValue()}</p>
          <p className="text-2xs text-slate-400">{ROLE_LABEL[info.row.original.actorRole]}</p>
        </div>
      ),
    }),
    column.accessor('occurredAt', {
      header: 'Requested',
      cell: (info) => (
        <span className="tabular-nums text-xs text-slate-500">
          {formatDateTime(info.getValue())}
        </span>
      ),
    }),
    column.accessor('reviewerStatus', {
      header: 'Review',
      cell: (info) => {
        const status = info.getValue();
        const item = info.row.original;
        return (
          <div>
            <Badge tone={STATUS_TONE[status]}>
              {status === 'PENDING_REVIEW' ? 'pending' : status.toLowerCase()}
            </Badge>
            {item.reviewerName ? (
              <p className="mt-0.5 text-2xs text-slate-400">{item.reviewerName}</p>
            ) : null}
          </div>
        );
      },
    }),
    column.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const item = info.row.original;
        if (!canReview || item.reviewerStatus !== 'PENDING_REVIEW') return null;
        return (
          <span className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>
            <Button size="sm" variant="ghost" onClick={() => openReview(item, 'REJECTED')}>
              Reject
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openReview(item, 'REVIEWED')}>
              Confirm
            </Button>
          </span>
        );
      },
    }),
  ];

  const rows = data?.items ?? [];
  const pendingCount = rows.filter((row) => row.reviewerStatus === 'PENDING_REVIEW').length;

  return (
    <div>
      <PageHeader
        title="Stage overrides"
        description="Every analyst override of a model-assigned IFRS 9 stage, with the before and after value, the required reason, the actor, and the reviewer's decision. A pending override is already live in the current staging; this queue is where a second person confirms or rolls it back."
        tags={<Badge tone="neutral">{pendingCount} pending on this page</Badge>}
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <Input
            aria-label="Search overrides"
            placeholder="Search exposure, borrower or reason…"
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
          />
          <Select
            aria-label="Filter by review status"
            value={list.filters.status ?? ''}
            onChange={(event) =>
              list.setFilter(
                'status',
                event.target.value === '' ? undefined : (event.target.value as ReviewerStatus),
              )
            }
          >
            <option value="">All review states</option>
            <option value="PENDING_REVIEW">Pending review</option>
            <option value="REVIEWED">Confirmed</option>
            <option value="REJECTED">Rejected</option>
          </Select>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Override register"
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
            title="No overrides match your filters"
            description="Try a different search term or review state."
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
            emptyTitle="No stage overrides"
            emptyDescription="The model's stage has never been overridden on this portfolio. Overrides are requested from an exposure detail page."
            emptyAction={
              <Link to="/portfolio">
                <Button size="sm">Open portfolio</Button>
              </Link>
            }
          />
        )}
        {data ? (
          <Pagination meta={data.meta} onPageChange={list.setPage} loading={isLoading} />
        ) : null}
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-2xs text-slate-500">
        <GitCompareArrows className="h-3.5 w-3.5" />
        Four-eyes control: the analyst who requested an override cannot review it. Both the request
        and the decision are written to the immutable audit trail.
      </p>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={
          selected
            ? `${selected.exposurePublicId} · stage ${selected.stageBefore} → ${selected.stageAfter}`
            : ''
        }
        description={selected ? `${selected.borrowerName} · ${selected.segment}` : undefined}
        footer={
          selected && canReview && selected.reviewerStatus === 'PENDING_REVIEW' ? (
            <span className="flex justify-end gap-2">
              <Button variant="danger" onClick={() => openReview(selected, 'REJECTED')}>
                Reject
              </Button>
              <Button onClick={() => openReview(selected, 'REVIEWED')}>Confirm override</Button>
            </span>
          ) : undefined
        }
      >
        {selected ? (
          <dl className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <StageBadge stage={selected.stageBefore} />
              <ArrowRight className="h-3 w-3 text-slate-400" />
              <StageBadge stage={selected.stageAfter} />
              <Badge tone={STATUS_TONE[selected.reviewerStatus]}>
                {selected.reviewerStatus === 'PENDING_REVIEW'
                  ? 'pending review'
                  : selected.reviewerStatus.toLowerCase()}
              </Badge>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-slate-400">
                Reason given by the analyst
              </dt>
              <dd className="mt-0.5 leading-relaxed text-slate-700">{selected.reason}</dd>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-2xs uppercase tracking-wider text-slate-400">Requested by</dt>
                <dd className="mt-0.5 text-xs text-slate-600">
                  {selected.actorName}
                  <span className="block text-slate-400">{ROLE_LABEL[selected.actorRole]}</span>
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wider text-slate-400">Requested at</dt>
                <dd className="mt-0.5 text-xs tabular-nums text-slate-600">
                  {formatDateTime(selected.occurredAt)}
                </dd>
              </div>
            </div>
            {selected.reviewerName ? (
              <div>
                <dt className="text-2xs uppercase tracking-wider text-slate-400">Reviewed</dt>
                <dd className="mt-0.5 text-xs text-slate-600">
                  {selected.reviewerName} · {formatDateTime(selected.reviewedAt ?? '')}
                  {selected.reviewComment ? (
                    <span className="mt-1 block text-slate-500">“{selected.reviewComment}”</span>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {selected.actorId === user?.id ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-slate-500">
                You requested this override, so you cannot review it. Ask another reviewer to
                confirm or reject it.
              </p>
            ) : null}
          </dl>
        ) : null}
      </Drawer>

      <Modal
        open={review !== null}
        onClose={() => setReview(null)}
        size="sm"
        title={review?.decision === 'REJECTED' ? 'Reject override' : 'Confirm override'}
        description={
          review
            ? `${review.item.exposurePublicId} · stage ${review.item.stageBefore} → ${review.item.stageAfter}`
            : undefined
        }
        footer={
          <span className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button
              variant={review?.decision === 'REJECTED' ? 'danger' : 'primary'}
              loading={reviewMutation.isPending}
              onClick={() => {
                if (!review) return;
                if (comment.trim().length < 3) {
                  setCommentError(
                    'A review comment of at least 3 characters is required for the audit trail.',
                  );
                  return;
                }
                reviewMutation.mutate({
                  item: review.item,
                  decision: review.decision,
                  note: comment.trim(),
                });
              }}
            >
              {review?.decision === 'REJECTED' ? 'Reject' : 'Confirm'}
            </Button>
          </span>
        }
      >
        <label className="block text-xs font-medium text-slate-600" htmlFor="review-comment">
          Review comment (required)
        </label>
        <textarea
          id="review-comment"
          className="mt-1.5 w-full rounded-lg border border-line px-3 py-2 text-sm focus:border-navy-400 focus:outline-none focus:ring-2 focus:ring-navy-100"
          rows={4}
          maxLength={2000}
          placeholder={
            review?.decision === 'REJECTED'
              ? 'Why is the model stage correct and the override not?'
              : 'What evidence supports moving this exposure to the overridden stage?'
          }
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
            setCommentError(null);
          }}
        />
        {commentError ? <p className="mt-1.5 text-2xs text-red-600">{commentError}</p> : null}
      </Modal>
    </div>
  );
}
