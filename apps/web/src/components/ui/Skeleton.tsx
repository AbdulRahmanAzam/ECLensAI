import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('shimmer rounded-lg bg-slate-200/70', className)} aria-hidden />;
}
