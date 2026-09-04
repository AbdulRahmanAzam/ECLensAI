import type { HTMLAttributes } from 'react';
import type { Stage } from '@eclens/shared';
import { cn } from '@/lib/utils';

export type BadgeTone =
  'neutral' | 'info' | 'positive' | 'warning' | 'danger' | 'stage1' | 'stage2' | 'stage3';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/15',
  info: 'bg-navy-50 text-navy-700 ring-navy-500/20',
  positive: 'bg-emerald-50 text-emerald-700 ring-emerald-500/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-500/25',
  danger: 'bg-red-50 text-red-700 ring-red-500/20',
  stage1: 'bg-teal-50 text-teal-700 ring-teal-500/20',
  stage2: 'bg-amber-50 text-amber-700 ring-amber-500/25',
  stage3: 'bg-red-50 text-red-700 ring-red-500/20',
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-400',
  info: 'bg-navy-500',
  positive: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  stage1: 'bg-teal-500',
  stage2: 'bg-amber-500',
  stage3: 'bg-red-500',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading status dot — use where the tone itself carries the meaning. */
  dot?: boolean;
}

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5',
        'text-2xs font-medium leading-4 ring-1 ring-inset',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASSES[tone])} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <Badge tone={`stage${stage}` as BadgeTone} dot>
      Stage {stage}
    </Badge>
  );
}

/** Standard label for all provisional demo content. */
export function SyntheticBadge() {
  return <Badge tone="warning">Synthetic Demo Data</Badge>;
}
