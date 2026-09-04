import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  tags?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, tags, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-navy-950">{title}</h1>
          {tags ? <div className="flex items-center gap-1.5">{tags}</div> : null}
        </div>
        {description ? <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
