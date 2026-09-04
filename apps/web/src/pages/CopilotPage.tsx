/**
 * The Portfolio Copilot.
 *
 * This page replaced a deterministic keyword matcher in Step 2. The rule that
 * matcher was built to honour still holds and is now enforced on the server: every
 * figure in an answer was copied out of a stored record the model was handed, and
 * an answer whose numbers cannot be found in that evidence is withheld rather than
 * shown. What the page owes the user is therefore not "trust me" but a way to
 * check — hence the citations, the evidence drawer, the caveats and the trail of
 * which records were read, on every turn.
 *
 * Answers arrive whole. Streaming is off server-side (`AiStatusResponse.streaming`)
 * because a figure on screen token by token would be there before the grounding
 * guard could reject it; the pending state says so plainly instead of pretending
 * to progress.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquarePlus, Send, Sparkles, X } from 'lucide-react';
import type { CopilotQueryRequest } from '@eclens/shared';
import { formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import { CopilotTurn } from '@/components/ai/CopilotTurn';
import { AiAvailabilityNotice } from '@/components/ai/AiChrome';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useAiStatus } from '@/hooks/useAi';
import { cn } from '@/lib/utils';

/** Offered until an answer supplies its own follow-ups. */
const STARTERS = [
  'What is the total loss allowance and coverage?',
  'Which exposures are highest risk?',
  'Show the staging breakdown',
  'What scenario weights are in force?',
  'How is ECL computed here?',
  'What is the lineage of these figures?',
  'What data quality issues are open?',
  'What does our credit policy say about staging?',
];

const FOCUS_FIELDS = ['exposureId', 'runId', 'snapshotId'] as const;
type FocusField = (typeof FOCUS_FIELDS)[number];

const FOCUS_LABEL: Record<FocusField, string> = {
  exposureId: 'Exposure',
  runId: 'Run',
  snapshotId: 'Snapshot',
};

interface Focus {
  exposureId?: string;
  runId?: string;
  snapshotId?: string;
}

export function CopilotPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const ai = useAiStatus();

  const [draft, setDraft] = useState('');
  /**
   * The question just sent, rendered as a user turn until the reply lands.
   *
   * Kept as a plain string rather than spliced into the thread: on a first
   * question there is no thread yet, so an optimistic turn built from
   * `thread.data` would show nothing at all in exactly the case where the wait is
   * most conspicuous.
   */
  const [asked, setAsked] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const threadId = searchParams.get('thread') ?? undefined;
  const focus = useMemo<Focus>(() => {
    const found: Focus = {};
    for (const field of FOCUS_FIELDS) {
      const value = searchParams.get(field);
      if (value) found[field] = value;
    }
    return found;
  }, [searchParams]);

  const openThread = (id: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('thread', id);
    else next.delete('thread');
    setSearchParams(next, { replace: true });
  };

  const clearFocus = (field: FocusField) => {
    const next = new URLSearchParams(searchParams);
    next.delete(field);
    setSearchParams(next, { replace: true });
  };

  const threads = useQuery({
    queryKey: ['copilot-threads'],
    queryFn: () => api.ai.listThreads({ page: 1, pageSize: 50, sortBy: 'updatedAt', sortDir: 'desc' }),
    enabled: ai.permitted,
  });

  const thread = useQuery({
    queryKey: ['copilot-thread', threadId],
    queryFn: () => api.ai.getThread(threadId as string),
    enabled: ai.permitted && Boolean(threadId),
  });

  const ask = useMutation({
    mutationFn: (input: CopilotQueryRequest) => api.ai.queryCopilot(input),
    onSuccess: (response) => {
      // The server returns the whole thread, so the cache is replaced rather than
      // patched — a turn the grounding guard withheld is in there too, labelled.
      queryClient.setQueryData(['copilot-thread', response.thread.id], response.thread);
      void queryClient.invalidateQueries({ queryKey: ['copilot-threads'] });
      openThread(response.thread.id);
      if (!response.availability.available) {
        push('info', 'Answered without the model', response.availability.message);
      }
    },
    onError: (error: unknown) => {
      push('error', 'The question was not answered', error instanceof Error ? error.message : 'The request failed.');
    },
    onSettled: () => setAsked(null),
  });

  const submit = (override?: string) => {
    const question = (override ?? draft).trim();
    if (!question || ask.isPending) return;
    setAsked(question);
    setDraft('');
    ask.mutate({ question, ...(threadId ? { threadId } : {}), ...focus });
  };

  const turns = thread.data?.turns ?? [];
  const latestAnswer = [...turns].reverse().find((turn) => turn.role === 'assistant');
  const suggestions = latestAnswer?.parsed?.suggestedQuestions ?? [];
  const chips = suggestions.length > 0 ? suggestions : STARTERS;
  const maxChars = ai.limits?.maxInputChars ?? 2000;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [turns.length, asked]);

  const transcript = () => {
    if (!ai.permitted) {
      return (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="Your role cannot use the copilot"
          description="AI features require the ai:use permission. Calculated figures, staging and the audit trail are all still available to you."
        />
      );
    }
    if (thread.isError) return <ErrorState onRetry={() => void thread.refetch()} />;
    if (threadId && thread.isLoading) {
      return (
        <div className="space-y-3">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-24 w-5/6" />
          <Skeleton className="h-12 w-1/2" />
        </div>
      );
    }
    if (turns.length === 0 && !asked) {
      return (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title={ai.available ? 'Ask about this portfolio' : 'The copilot cannot answer right now'}
          description={
            ai.available
              ? 'Every figure in a reply is copied from a stored record and cited. Try a question below, or type your own.'
              : 'The assistant needs a configured model. Stored figures and the audit trail are unaffected.'
          }
          action={
            ai.available ? (
              <div className="flex flex-wrap justify-center gap-2">
                {STARTERS.slice(0, 3).map((starter) => (
                  <Button key={starter} size="sm" variant="secondary" onClick={() => submit(starter)}>
                    {starter}
                  </Button>
                ))}
              </div>
            ) : undefined
          }
        />
      );
    }
    return (
      <div className="space-y-5">
        {turns.map((turn) => (
          <CopilotTurn
            key={turn.id}
            turn={turn}
            threadId={threadId ?? ''}
            onAsk={submit}
            isLatest={turn.id === latestAnswer?.id}
            disabled={ask.isPending}
          />
        ))}
        {asked ? (
          <CopilotTurn
            key="asked"
            turn={{ id: 'asked', role: 'user', content: asked, createdAt: new Date().toISOString() }}
            threadId={threadId ?? ''}
            onAsk={submit}
          />
        ) : null}
        {ask.isPending ? (
          <div className="flex justify-start gap-2">
            <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-700">
              <Loader2 className="h-4 w-4 animate-spin" />
            </span>
            <div className="max-w-[86%] rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="flex items-center gap-2 text-xs text-slate-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-navy-500" />
                Reading this organisation’s stored records…
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                Answers arrive whole, after every figure in them has been checked against the records they cite.
                Nothing is shown token by token, because an unchecked number should never reach the screen first.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="AI Copilot"
        description="Ask about the portfolio. The assistant reads this organisation's stored records through a fixed set of read-only tools, quotes their figures at their stored precision, and cites where each one came from. It cannot change a staging decision, approve a run or calculate an ECL."
        tags={
          ai.data ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={ai.data.availability.available ? 'positive' : 'neutral'}>
                {ai.data.availability.available ? `live · ${ai.data.availability.model}` : 'AI unavailable'}
              </Badge>
              {ai.data.streaming ? null : <Badge tone="neutral">answers arrive whole</Badge>}
            </span>
          ) : undefined
        }
        actions={
          <Button
            variant="secondary"
            icon={<MessageSquarePlus className="h-4 w-4" />}
            onClick={() => openThread(undefined)}
            disabled={!ai.permitted}
          >
            New conversation
          </Button>
        }
      />

      {ai.data && !ai.data.availability.available ? (
        <div className="mb-4">
          <AiAvailabilityNotice availability={ai.data.availability} />
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_1fr]">
        <Card className="flex max-h-[70vh] flex-col overflow-hidden">
          <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Your conversations
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {threads.isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : (threads.data?.items.length ?? 0) === 0 ? (
              <p className="px-3 py-4 text-[11px] leading-relaxed text-slate-500">
                No conversations yet. Threads are yours alone — another analyst cannot open them, and neither can a
                user at another organisation.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {threads.data?.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => openThread(item.id)}
                      className={cn(
                        'block w-full px-3 py-2 text-left transition-colors hover:bg-slate-50',
                        item.id === threadId ? 'bg-navy-50' : '',
                      )}
                    >
                      <span className="block truncate text-xs font-medium text-slate-800">{item.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                        {formatDateTime(item.updatedAt)} · {item.turnCount} turn{item.turnCount === 1 ? '' : 's'}
                        {item.hasDegradedTurn ? <Badge tone="warning">demo answer</Badge> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {threads.data && threads.data.meta.totalItems > threads.data.items.length ? (
            <p className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400">
              Showing the {threads.data.items.length} most recent of {threads.data.meta.totalItems}.
            </p>
          ) : null}
        </Card>

        <Card className="flex min-h-[28rem] flex-col overflow-hidden">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            {transcript()}
          </div>

          <div className="border-t border-slate-100 px-4 py-3">
            {FOCUS_FIELDS.some((field) => focus[field]) ? (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500">Answering about:</span>
                {FOCUS_FIELDS.map((field) =>
                  focus[field] ? (
                    <span
                      key={field}
                      className="inline-flex items-center gap-1 rounded border border-navy-200 bg-navy-50 px-1.5 py-0.5 text-[11px] text-navy-800"
                    >
                      {FOCUS_LABEL[field]} {focus[field]}
                      <button
                        type="button"
                        aria-label={`Clear the ${FOCUS_LABEL[field].toLowerCase()} focus`}
                        onClick={() => clearFocus(field)}
                        className="rounded text-navy-500 hover:text-navy-900"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : null,
                )}
              </div>
            ) : null}

            <div className="mb-2 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => submit(chip)}
                  disabled={!ai.permitted || ask.isPending}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:border-navy-300 hover:text-navy-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {chip}
                </button>
              ))}
            </div>

            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                maxLength={maxChars}
                placeholder="Ask about staging, scenarios, coverage, lineage or data quality…"
                aria-label="Message the copilot"
                disabled={!ai.permitted || ask.isPending}
                className="flex-1 resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500 disabled:bg-slate-50"
              />
              <Button
                icon={<Send className="h-4 w-4" />}
                loading={ask.isPending}
                disabled={!ai.permitted || draft.trim().length < 2}
                onClick={() => submit()}
              >
                Send
              </Button>
            </div>
            <p className="mt-1.5 text-right text-[10px] tabular-nums text-slate-400">
              {draft.length}/{maxChars}
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
