import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Right-hand side panel for secondary flows (mobile nav, detail previews). */
export function Drawer({ open, onClose, title, description, children, footer }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 animate-fade-in bg-ink/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute right-0 top-0 flex h-full w-full max-w-md animate-slide-in-right flex-col border-l border-line bg-surface shadow-pop"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="-mr-1 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="border-t border-line-soft bg-surface-2 px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
