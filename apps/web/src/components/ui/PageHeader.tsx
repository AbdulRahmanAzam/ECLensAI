import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  tags?: ReactNode;
  actions?: ReactNode;
  /** Small label above the title — section or context, not a repeat of it. */
  eyebrow?: string;
}

export function PageHeader({ title, description, tags, actions, eyebrow }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-brand">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.375rem] font-semibold tracking-tightest text-slate-900 md:text-2xl">
            {title}
          </h1>
          {tags ? <div className="flex items-center gap-1.5">{tags}</div> : null}
        </div>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
