import { cn } from '@/lib/utils';

/**
 * The ECLens mark: a lens aperture drawn as a rising loss curve. Shared by the
 * sidebar, the marketing header, the sign-in panel and the route splash so the
 * identity is defined once rather than re-lettered as an "E" in four places.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative inline-flex items-center justify-center overflow-hidden rounded-xl',
        'bg-gradient-to-br from-ink-3 to-ink shadow-xs ring-1 ring-inset ring-white/15',
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 32 32" fill="none" className="h-[62%] w-[62%]">
        <path
          d="M6 24 13.5 9 21 24"
          stroke="currentColor"
          className="text-teal-300"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.4 19.2h8.2"
          stroke="currentColor"
          className="text-teal-300"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <circle cx="24" cy="10" r="3.2" className="fill-teal-400/80" />
      </svg>
    </span>
  );
}
