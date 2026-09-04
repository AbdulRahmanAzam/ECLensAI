import type { ReactNode } from 'react';

/** Lightweight CSS tooltip for icon buttons and compact labels. */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-2xs font-medium text-white opacity-0 shadow-pop transition-[opacity,transform] duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
