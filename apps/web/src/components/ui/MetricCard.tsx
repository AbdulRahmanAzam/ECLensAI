import type { ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  /** Signed change (e.g. +0.004). Rendered as a percentage with 2 decimals. */
  delta?: number;
  /** When true, a negative delta is the good outcome (e.g. fewer defaults). */
  negativeIsGood?: boolean;
  icon?: ReactNode;
  loading?: boolean;
}

export function MetricCard({
  label,
  value,
  hint,
  delta,
  negativeIsGood,
  icon,
  loading,
}: MetricCardProps) {
  const flat = delta !== undefined && delta === 0;
  const good = delta !== undefined && (negativeIsGood ? delta < 0 : delta > 0);
  const Arrow = flat ? Minus : delta !== undefined && delta >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-line/80 bg-surface shadow-lifted">
      {/* A metric tile is read at a glance, so it earns one deliberate accent:
          a brand rule along the top edge that colours in on hover. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-brand/0 via-brand/60 to-accent/50 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="flex flex-1 flex-col p-5">
        {/* A row of tiles is read by comparing figures across it, so the label
            box reserves two lines: without it a longer label pushes its own
            figure out of line with the one beside it. */}
        <div className="flex min-h-[2rem] items-start justify-between gap-3">
          <p className="text-2xs font-semibold uppercase leading-4 tracking-[0.1em] text-slate-500">
            {label}
          </p>
          {icon ? (
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-soft text-brand ring-1 ring-inset ring-navy-500/12">
              {icon}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="shimmer mt-3.5 h-9 w-36 rounded-lg bg-slate-200/70" />
        ) : (
          <p className="mt-3 font-display text-[2.1rem] font-normal leading-none tracking-tight text-slate-900 tabular-nums">
            {value}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-xs">
          {delta !== undefined ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums ring-1 ring-inset',
                flat
                  ? 'bg-slate-100 text-slate-600 ring-slate-500/15'
                  : good
                    ? 'bg-emerald-50 text-emerald-700 ring-emerald-500/20'
                    : 'bg-red-50 text-red-700 ring-red-500/20',
              )}
            >
              <Arrow className="h-3 w-3" aria-hidden />
              {(delta * 100).toFixed(2)}%
            </span>
          ) : null}
          {hint ? <span className="text-slate-500">{hint}</span> : null}
        </div>
      </div>
    </div>
  );
}
