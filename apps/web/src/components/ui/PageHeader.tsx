import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  tags?: ReactNode;
  actions?: ReactNode;
  /** Small label above the title — section or context, not a repeat of it. */
  eyebrow?: string;
}

/**
 * The page title is set in the display serif. It is the one editorial note in
 * an otherwise strictly functional interface, and it is what tells you this is
 * a considered reporting product rather than a generic admin table.
 */
export function PageHeader({ title, description, tags, actions, eyebrow }: PageHeaderProps) {
  return (
    <header className="mb-7">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-brand">
              <span className="h-px w-5 bg-brand/40" aria-hidden />
              {eyebrow}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[2rem] font-normal leading-[1.1] tracking-tight text-slate-900 md:text-[2.35rem]">
              {title}
            </h1>
            {tags ? <div className="flex items-center gap-1.5 pb-1">{tags}</div> : null}
          </div>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 pb-1">{actions}</div>
        ) : null}
      </div>
      <div className="rule-fade mt-5" aria-hidden />
    </header>
  );
}
