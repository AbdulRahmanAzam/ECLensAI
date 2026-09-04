import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={selectId} className="block text-xs font-medium text-slate-600">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          className={cn(
            'h-9 w-full appearance-none rounded-lg border bg-surface pl-3 pr-9 text-sm text-slate-900 shadow-xs',
            'transition-[border-color,box-shadow] duration-150',
            'focus:outline-none focus:ring-2 focus:ring-brand/25',
            error
              ? 'border-red-400 focus:border-red-500 focus:ring-red-500/25'
              : 'border-line hover:border-slate-300 focus:border-brand',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
      </div>
      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
});
