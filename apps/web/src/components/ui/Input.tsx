import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Leading adornment (icon or currency symbol). Purely decorative. */
  adornment?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, adornment, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={inputId} className="block text-xs font-medium text-slate-600">
          {label}
        </label>
      ) : null}
      <div className="relative">
        {adornment ? (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
            {adornment}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cn(
            'h-9 w-full rounded-lg border bg-surface px-3 text-sm text-slate-900 shadow-xs',
            'transition-[border-color,box-shadow] duration-150',
            'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand/25',
            error
              ? 'border-red-400 focus:border-red-500 focus:ring-red-500/25'
              : 'border-line hover:border-slate-300 focus:border-brand',
            adornment && 'pl-9',
            className,
          )}
          {...rest}
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
