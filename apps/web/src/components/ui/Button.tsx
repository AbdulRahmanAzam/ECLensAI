import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'accent' | 'inverse';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // A shallow vertical gradient plus the inset top highlight from `shadow-control`
  // is what makes the primary control read as a physical, lit surface instead of
  // a flat filled rectangle.
  primary:
    'border-transparent bg-gradient-to-b from-navy-700 to-navy-800 text-white shadow-control hover:from-navy-800 hover:to-navy-900 active:translate-y-px',
  secondary:
    'border-line bg-gradient-to-b from-white to-surface-2 text-slate-700 shadow-xs hover:border-line-strong hover:text-slate-900 active:translate-y-px',
  outline:
    'border-navy-200 bg-brand-soft/50 text-navy-700 hover:border-navy-300 hover:bg-brand-soft',
  ghost: 'border-transparent bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900',
  danger:
    'border-transparent bg-gradient-to-b from-red-500 to-red-600 text-white shadow-control hover:from-red-600 hover:to-red-700 active:translate-y-px',
  accent:
    'border-transparent bg-gradient-to-b from-teal-500 to-teal-600 text-white shadow-control hover:from-teal-600 hover:to-teal-700 active:translate-y-px',
  // For controls sitting on the always-dark chrome (hero, sign-in panel).
  // A real variant, not a className override — `cn` is clsx, so overriding a
  // variant's colours from the call site would depend on stylesheet order.
  inverse:
    'border-white/25 bg-white/[0.06] text-white backdrop-blur-sm hover:border-white/40 hover:bg-white/[0.12] active:translate-y-px',
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
        'inline-flex select-none items-center justify-center whitespace-nowrap border font-medium',
        'transition-[background,border-color,color,box-shadow,transform] duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2',
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
