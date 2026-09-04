import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'accent';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // The primary button carries a one-pixel top highlight so it reads as a lit
  // surface rather than a flat rectangle.
  primary:
    'border border-brand/70 bg-brand text-white shadow-xs shadow-brand/30 hover:bg-brand-hover hover:shadow-raised active:translate-y-px',
  secondary:
    'border border-line bg-surface text-slate-700 shadow-xs hover:border-slate-300 hover:bg-surface-2 hover:text-slate-900 active:translate-y-px',
  outline:
    'border border-brand/30 bg-brand/[0.04] text-brand hover:border-brand/50 hover:bg-brand/10',
  ghost:
    'border border-transparent bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900',
  danger:
    'border border-red-600/70 bg-red-600 text-white shadow-xs shadow-red-600/25 hover:bg-red-700 active:translate-y-px',
  accent:
    'border border-transparent bg-accent text-white shadow-xs shadow-accent/25 hover:brightness-110 active:translate-y-px',
};

const SIZE_CLASSES: Record<Size, string> = {
  xs: 'h-7 gap-1.5 rounded-lg px-2.5 text-2xs',
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-xs',
  md: 'h-9 gap-2 rounded-lg px-4 text-sm',
  lg: 'h-11 gap-2 rounded-xl px-5 text-sm',
  icon: 'h-9 w-9 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});
