import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Lifts on hover — only for cards that are themselves a link or a target. */
  interactive?: boolean;
}

export function Card({ className, interactive, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface shadow-card',
        interactive &&
          'transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-raised',
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
        'flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...rest} />;
}
