import type { HTMLAttributes } from 'react';
import type { Stage } from '@eclens/shared';
import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'positive'
  | 'warning'
  | 'danger'
  | 'stage1'
  | 'stage2'
  | 'stage3';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  info: 'bg-navy-50 text-navy-700 border-navy-200',
  positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  stage1: 'bg-teal-50 text-teal-700 border-teal-200',
  stage2: 'bg-amber-50 text-amber-800 border-amber-200',
  stage3: 'bg-red-50 text-red-700 border-red-200',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={`stage${stage}` as BadgeTone}>Stage {stage}</Badge>;
}

/** Standard label for all provisional demo content. */
export function SyntheticBadge() {
  return <Badge tone="warning">Synthetic Demo Data</Badge>;
}
