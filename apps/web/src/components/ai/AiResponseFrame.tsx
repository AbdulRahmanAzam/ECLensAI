/**
 * The state machine every AI panel shares.
 *
 * Six states, in the order they are checked, because getting the order wrong is
 * how a product ends up either hiding a real failure or apologising for a working
 * answer:
 *
 *   1. in flight           — a spinner, and no guess at what is coming
 *   2. request failed      — rate limited, forbidden, or an id that is not ours
 *   3. nothing asked yet   — the caller's own idle content
 *   4. model unavailable   — `status: 'UNAVAILABLE'`, `result: null`
 *   5. no grounded answer  — withheld, schema-invalid, or failed mid-call
 *   6. an answer           — the caller's own rendering of `result`
 *
 * States 4 and 5 are the reason this component exists. Both arrive as HTTP 200
 * with `result: null`, and both must be shown as what they are: a panel that says
 * plainly why there is no answer. Filling the gap with something plausible is the
 * one thing the whole feature is built not to do.
 */
import type { ReactNode } from 'react';
import { Ban, Info } from 'lucide-react';
import type { AiResponse } from '@eclens/shared';
import { AiAvailabilityNotice, AiDisclaimer, AiToolTrail } from './AiChrome';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { STATUS_TONE, statusLabel } from '@/lib/ai';
import { cn } from '@/lib/utils';

export interface AiResponseFrameProps<TResult> {
  response: AiResponse<TResult> | null;
  failure: string | null;
  isPending: boolean;
  title: string;
  description?: string;
  onRetry?: () => void;
  /** Rendered in place of the body when nothing has been asked yet. */
  idle?: ReactNode;
  /** Extra badges beside the status, e.g. the answer's confidence label. */
  tags?: ReactNode;
  /**
   * The trigger button, kept in the header rather than above the card so a panel
   * is one card whether or not it has answered yet.
   */
  actions?: ReactNode;
  children: (result: TResult, response: AiResponse<TResult>) => ReactNode;
}

export function AiResponseFrame<TResult>({
  response,
  failure,
  isPending,
  title,
  description,
  onRetry,
  idle,
  tags,
  actions,
  children,
}: AiResponseFrameProps<TResult>) {
  const answered = response !== null && response.result !== null;

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line-soft px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-navy-950">{title}</p>
        {description ? (
          <p className="mt-0.5 text-2xs leading-relaxed text-slate-500">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {response ? (
          <>
            <Badge tone={STATUS_TONE[response.status]}>{statusLabel(response.status)}</Badge>
            <span className="tabular-nums text-2xs text-slate-400">{response.latencyMs} ms</span>
          </>
        ) : null}
        {tags}
        {actions}
      </div>
    </div>
  );

  let body: ReactNode;

  if (isPending) {
    body = (
      <div className="space-y-3 px-4 py-4">
        <AiToolTrail activity={[]} pending />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (failure) {
    // A real HTTP failure. Distinct from state 5 on purpose: this one has no
    // availability record to show, because no envelope ever came back.
    body = (
      <div className="px-4 py-4">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="flex items-center gap-2 text-sm font-medium text-red-800">
            <Ban className="h-4 w-4" />
            The AI request was refused
          </p>
          <p className="mt-1 text-xs leading-relaxed text-red-700">{failure}</p>
        </div>
        {onRetry ? (
          <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  } else if (!response) {
    body = <div className="px-4 py-4">{idle ?? null}</div>;
  } else if (!answered) {
    body = (
      <div className="space-y-3 px-4 py-4">
        {response.status === 'UNAVAILABLE' ? (
          <AiAvailabilityNotice availability={response.availability} />
        ) : (
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <Info className="h-4 w-4 text-slate-500" />
              No answer to show
            </p>
            {/* The server's own wording. It distinguishes a withheld answer from a
                malformed one, and paraphrasing it here would lose exactly the
                detail a reviewer needs. */}
            <p className="mt-1 text-xs leading-relaxed text-slate-600">{response.message}</p>
            {response.aiRequestId ? (
              <p className="mt-1.5 font-mono text-2xs text-slate-400">
                AI request {response.aiRequestId}
              </p>
            ) : null}
          </div>
        )}
        <AiToolTrail activity={response.toolActivity} />
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3 px-4 py-4">
        {children(response.result as TResult, response)}
        <div className="border-t border-line-soft pt-3">
          <AiToolTrail activity={response.toolActivity} />
        </div>
      </div>
    );
  }

  return (
    <Card className={cn(!isPending && !failure && !answered && 'border-dashed')}>
      {header}
      {body}
      <div className="border-t border-line-soft px-4 py-3">
        <AiDisclaimer />
      </div>
    </Card>
  );
}
