/**
 * One turn of a copilot conversation.
 *
 * The user half is a bubble. The assistant half carries everything the answer was
 * required to bring with it — the sources it may quote from, the citations, the
 * caveats the model had to state, and the tools that were consulted — because an
 * answer without those is the thing this product refuses to show.
 *
 * A degraded turn is labelled as one. When no model answered, the server returns a
 * deterministic summary of stored records instead, and presenting that in the same
 * voice as an AI answer would be the exact fabrication the feature exists to
 * prevent.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { CopilotTurnRecord } from '@eclens/shared';
import { formatDateTime } from '@eclens/shared';
import { api } from '@/api/client';
import {
  AiCaveats,
  AiConfidenceBadge,
  AiDisclaimer,
  AiEvidence,
  AiSourceRefs,
  AiToolTrail,
} from './AiChrome';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { answerToClipboardText } from '@/lib/ai';
import { cn, copyText } from '@/lib/utils';

export interface CopilotTurnProps {
  turn: CopilotTurnRecord;
  /** The thread's public id, which the feedback endpoint is addressed by. */
  threadId: string;
  /** Sends a suggested question as the next turn. */
  onAsk: (question: string) => void;
  /** The last assistant turn gets the suggestion chips; earlier ones do not. */
  isLatest?: boolean;
  disabled?: boolean;
}

export function CopilotTurn({ turn, threadId, onAsk, isLatest, disabled }: CopilotTurnProps) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const feedback = useMutation({
    mutationFn: (vote: 'UP' | 'DOWN') =>
      api.ai.feedback(threadId, turn.id, { vote, ...(note.trim() ? { comment: note.trim() } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['copilot-thread', threadId] });
      setNoteOpen(false);
      setNote('');
    },
    onError: () => push('error', 'Feedback not recorded', 'The vote could not be saved. The answer itself is unaffected.'),
  });

  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-navy-800 px-4 py-2.5 text-sm leading-relaxed text-white">
          <p className="whitespace-pre-wrap">{turn.content}</p>
          <p className="mt-1 text-right text-[10px] text-navy-200">{formatDateTime(turn.createdAt)}</p>
        </div>
      </div>
    );
  }

  const answer = turn.parsed;

  const copy = async () => {
    // The structured answer, not just the prose: whoever receives it needs the
    // citations to be able to check it.
    const text = answer ? answerToClipboardText(answer) : turn.content;
    const copied = await copyText(text);
    push(copied ? 'success' : 'error', copied ? 'Answer copied' : 'Copy failed', copied ? undefined : 'This browser would not write to the clipboard.');
  };

  return (
    <div className="flex justify-start gap-2">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-700">
        <Bot className="h-4 w-4" />
      </span>
      <div className="min-w-0 max-w-[86%] flex-1 space-y-2.5">
        <div
          className={cn(
            'rounded-lg border px-4 py-3',
            turn.degraded ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50',
          )}
        >
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {answer ? <AiConfidenceBadge label={answer.confidenceLabel} /> : null}
            {turn.degraded ? <Badge tone="warning">Demo explanation — no model answered</Badge> : null}
            {turn.status === 'SCHEMA_REPAIRED' ? <Badge tone="warning">corrected on retry</Badge> : null}
            {turn.model ? <span className="font-mono text-[10px] text-slate-400">{turn.model}</span> : null}
            {typeof turn.latencyMs === 'number' ? (
              <span className="tabular-nums text-[10px] text-slate-400">{turn.latencyMs} ms</span>
            ) : null}
          </div>

          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{turn.content}</p>

          {answer ? (
            <div className="mt-3 space-y-2.5 border-t border-slate-200/70 pt-3">
              <AiSourceRefs refs={answer.sourceRefs} />
              <AiCaveats items={answer.caveats} />
              <AiEvidence items={answer.evidence} />
            </div>
          ) : null}
        </div>

        <details className="rounded-md border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
            What was consulted
          </summary>
          <div className="border-t border-slate-100 px-3 py-2">
            <AiToolTrail activity={turn.toolActivity ?? []} />
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => void copy()}
            aria-label="Copy this answer with its citations"
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={turn.feedbackVote === 'UP' ? <Check className="h-3.5 w-3.5" /> : <ThumbsUp className="h-3.5 w-3.5" />}
            loading={feedback.isPending && feedback.variables === 'UP'}
            disabled={feedback.isPending}
            onClick={() => feedback.mutate('UP')}
            className={turn.feedbackVote === 'UP' ? 'text-emerald-700' : undefined}
            aria-pressed={turn.feedbackVote === 'UP'}
          >
            Helpful
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ThumbsDown className="h-3.5 w-3.5" />}
            loading={feedback.isPending && feedback.variables === 'DOWN'}
            disabled={feedback.isPending}
            onClick={() => {
              // A downvote with no reason cannot improve anything, so the note
              // field is offered rather than the vote simply being recorded.
              if (turn.feedbackVote === 'DOWN') {
                setNoteOpen((open) => !open);
                return;
              }
              setNoteOpen(true);
              feedback.mutate('DOWN');
            }}
            className={turn.feedbackVote === 'DOWN' ? 'text-red-700' : undefined}
            aria-pressed={turn.feedbackVote === 'DOWN'}
          >
            Not right
          </Button>
          <span className="ml-auto text-[10px] text-slate-400">{formatDateTime(turn.createdAt)}</span>
        </div>

        {noteOpen ? (
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  feedback.mutate('DOWN');
                }
              }}
              placeholder="What was wrong — a figure, a citation, a missing caveat?"
              aria-label="Note about this answer"
              maxLength={1000}
              className="h-8 flex-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900 focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500"
            />
            <Button size="sm" variant="secondary" loading={feedback.isPending} onClick={() => feedback.mutate('DOWN')}>
              Save note
            </Button>
          </div>
        ) : null}

        {isLatest && answer && answer.suggestedQuestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {answer.suggestedQuestions.map((question) => (
              <button
                key={question}
                type="button"
                disabled={disabled}
                onClick={() => onAsk(question)}
                className="rounded-full border border-navy-200 bg-white px-2.5 py-1 text-[11px] text-navy-800 transition-colors hover:border-navy-400 hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {question}
              </button>
            ))}
          </div>
        ) : null}

        {isLatest ? <AiDisclaimer className="mt-1" /> : null}
      </div>
    </div>
  );
}
