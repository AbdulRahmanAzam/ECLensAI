import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-slate-400">
        {icon ?? <Inbox className="h-5 w-5" />}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {description ? (
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
