/**
 * The pieces every AI panel shares.
 *
 * These exist as one module rather than being inlined per feature because the
 * guarantee they carry has to look and read the same everywhere: a citation the
 * user can open, the tools that were consulted, the caveats the model was made to
 * state, and the notice that AI can be wrong. Seven features that each rendered
 * their own version would drift, and the drift would be invisible until somebody
 * relied on the one panel that forgot the disclaimer.
 *
 * The wording and link targets live in `lib/ai.ts`, not here, so they can be
 * asserted without a browser.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CircleSlash,
  ExternalLink,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AiAvailabilityRecord,
  AiConfidenceLabel,
  AiSourceRef,
  AiToolActivity,
} from '@eclens/shared';
import { Badge } from '@/components/ui/Badge';
import { CONFIDENCE_TONE, confidenceLabel, refKindLabel, refLabel, refRoute } from '@/lib/ai';
import { cn } from '@/lib/utils';

export function AiConfidenceBadge({ label }: { label: AiConfidenceLabel }) {
  return <Badge tone={CONFIDENCE_TONE[label]}>{confidenceLabel(label)}</Badge>;
}

/**
 * The notice required next to every AI answer.
 *
 * The text comes from the server when the status call has landed, because that is
 * where the policy lives, and falls back to the shared constant otherwise so the
 * notice is never absent while a request is in flight.
 */
export function AiDisclaimer({ text, className }: { text?: string; className?: string }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900',
        className,
      )}
    >
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text ?? 'AI can make mistakes. Verify every figure against the cited source before relying on it.'}</span>
    </p>
  );
}

/**
 * Shown instead of an answer when the deployment cannot reach a model.
 *
 * `message` is written by the server for a person to read verbatim, and `reason`
 * distinguishes "no key configured" from "AI switched off", which are different
 * problems with different owners.
 */
export function AiAvailabilityNotice({
  availability,
  children,
}: {
  availability: AiAvailabilityRecord;
  children?: ReactNode;
}) {
  if (availability.available) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <CircleSlash className="h-4 w-4 text-slate-500" />
        AI unavailable
        <Badge tone="neutral">{availability.reason.replace(/_/g, ' ').toLowerCase()}</Badge>
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{availability.message}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        Calculated figures, staging decisions and the audit trail are unaffected — they are produced by the
        deterministic engine, not by this model.
      </p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool activity
// ---------------------------------------------------------------------------

const TOOL_STATUS_ICON: Record<AiToolActivity['status'], ReactNode> = {
  CALLED: <Loader2 className="h-3.5 w-3.5 animate-spin text-navy-500" />,
  SUCCEEDED: <Check className="h-3.5 w-3.5 text-emerald-600" />,
  FAILED: <X className="h-3.5 w-3.5 text-red-500" />,
  REFUSED: <CircleSlash className="h-3.5 w-3.5 text-amber-600" />,
};

/**
 * Which stored records the answer was built from, in the words a risk analyst
 * uses — `label`, never the tool's function name.
 *
 * While a call is in flight there is nothing to report yet: the response arrives
 * whole, after the grounding guard has seen it, so `pending` renders a single
 * honest line instead of inventing progress.
 */
export function AiToolTrail({ activity, pending }: { activity: AiToolActivity[]; pending?: boolean }) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-navy-500" />
        Reading this organisation’s stored records…
      </p>
    );
  }
  if (activity.length === 0) {
    return (
      <p className="text-[11px] text-slate-500">
        No stored record was read for this answer. A response with no evidence behind it is withheld rather than
        shown.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {activity.map((entry, index) => (
        <li key={`${entry.tool}-${index}`} className="flex items-start gap-2 text-[11px] text-slate-600">
          <span className="mt-0.5 shrink-0">{TOOL_STATUS_ICON[entry.status]}</span>
          <span className="min-w-0">
            {entry.label}
            <span className="ml-1.5 tabular-nums text-slate-400">{entry.durationMs} ms</span>
            {entry.detail ? <span className="ml-1.5 text-slate-500">— {entry.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

function SourceRefChip({ source }: { source: AiSourceRef }) {
  const route = refRoute(source);
  const text = (
    <>
      <span className="text-slate-400">{refKindLabel(source.kind)}</span>
      <span className="font-medium text-navy-800">{refLabel(source)}</span>
      {source.locator ? <span className="text-slate-500">{source.locator}</span> : null}
      {route ? <ExternalLink className="h-3 w-3 text-slate-400" /> : null}
    </>
  );
  const classes =
    'inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] leading-4 transition-colors';

  // A citation is the user's way back to the record. Where the record has a page
  // in this app the chip links to it; where it does not, the chip still names the
  // source rather than dropping it.
  return route ? (
    <Link to={route} className={cn(classes, 'hover:border-navy-300 hover:bg-navy-50')}>
      {text}
    </Link>
  ) : (
    <span className={classes}>{text}</span>
  );
}

export function AiSourceRefs({ refs, title = 'Sources' }: { refs: AiSourceRef[]; title?: string }) {
  if (refs.length === 0) return null;
  return (
    <div>
      {title ? (
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {refs.map((source, index) => (
          <SourceRefChip key={`${source.kind}-${source.id}-${index}`} source={source} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Caveats, evidence and prose
// ---------------------------------------------------------------------------

export function AiCaveats({ items, title = 'Caveats' }: { items: string[]; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
        <AlertTriangle className="h-3 w-3" />
        {title}
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-slate-600">
        {items.map((caveat, index) => (
          <li key={index}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

/** The verbatim record extracts the answer was allowed to quote from. */
export function AiEvidence({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-md border border-slate-200 bg-white">
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
        Evidence the answer may quote ({items.length})
      </summary>
      <ul className="space-y-1.5 border-t border-slate-100 px-3 py-2">
        {items.map((item, index) => (
          <li key={index} className="font-mono text-[11px] leading-relaxed text-slate-600">
            {item}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A bulleted block of prose lines the model returned, under a small heading. */
export function AiLineList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</p>
      <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-700">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** A prose paragraph under the heading the feature contract names it by. */
export function AiProse({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{body}</p>
    </div>
  );
}
