import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Lifts on hover — only for cards that are themselves a link or a target. */
  interactive?: boolean;
  /** Quieter panel for supporting content: no drop shadow, tinted fill. */
  muted?: boolean;
}

export function Card({ className, interactive, muted, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border',
        muted
          ? 'border-line bg-surface-2'
          : 'border-line/80 bg-surface shadow-lifted backdrop-blur-[2px]',
        interactive &&
          'transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-raised',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 border-b border-line-soft px-5 py-3.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? (
          <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand ring-1 ring-inset ring-navy-500/15">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...rest} />;
}

/** Quiet strip at the bottom of a card — totals, counts, secondary actions. */
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-b-2xl border-t border-line-soft bg-surface-2/70 px-5 py-3 text-xs text-slate-500',
        className,
      )}
      {...rest}
    />
  );
}
