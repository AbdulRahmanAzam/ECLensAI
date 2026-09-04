import type { ReactNode } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
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

export function MetricCard({ label, value, hint, delta, negativeIsGood, icon, loading }: MetricCardProps) {
  const good = delta !== undefined && (negativeIsGood ? delta < 0 : delta > 0);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {icon ? <span className="text-navy-500">{icon}</span> : null}
      </div>
      {loading ? (
        <div className="mt-2 h-7 w-32 animate-pulse rounded bg-slate-200" />
      ) : (
        <p className="mt-2 text-2xl font-semibold tracking-tight text-navy-950">{value}</p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {delta !== undefined ? (
          <span className={cn('inline-flex items-center gap-0.5 font-medium', good ? 'text-emerald-600' : 'text-red-600')}>
            {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {(delta * 100).toFixed(2)}%
          </span>
        ) : null}
        {hint ? <span className="text-slate-500">{hint}</span> : null}
      </div>
    </Card>
  );
}
