import type { ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Card } from './Card';
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
    <Card className="group relative overflow-hidden p-4">
      {/* Hairline accent that only shows on hover — keeps a wall of metric
          tiles calm while still giving each one a focus state. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</p>
        {icon ? (
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
            {icon}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-3 h-8 w-32 animate-pulse rounded-lg bg-slate-200" />
      ) : (
        <p className="mt-2.5 text-[1.65rem] font-semibold leading-none tracking-tightest text-slate-900 tabular-nums">
          {value}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
    </Card>
  );
}
