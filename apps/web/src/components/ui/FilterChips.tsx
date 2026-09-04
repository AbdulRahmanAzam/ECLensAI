import { X } from 'lucide-react';

export interface FilterChip {
  key: string;
  label: string;
}

export interface FilterChipsProps {
  chips: FilterChip[];
  onRemove: (key: string) => void;
  onClearAll?: () => void;
}

/**
 * Active-filter chips for a page whose filters live in the URL.
 *
 * Exists so a judge (or an analyst) can always see the current scope at a
 * glance rather than having to reopen every filter control to check what is
 * selected — the working rule this satisfies is literal: "show active-filter
 * chips so a judge always understands the current scope."
 */
export function FilterChips({ chips, onRemove, onClearAll }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Active filters">
      {chips.map((chip) => (
        <span
          key={chip.key}
          role="listitem"
          className="inline-flex items-center gap-1 rounded-full border border-navy-200 bg-navy-50 py-1 pl-2.5 pr-1.5 text-xs font-medium text-navy-800"
        >
          {chip.label}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            aria-label={`Remove filter: ${chip.label}`}
            className="rounded-full p-0.5 text-navy-500 hover:bg-navy-100 hover:text-navy-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && onClearAll ? (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
