import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search } from 'lucide-react';
import type { ListQuery } from '@eclens/shared';
import { api } from '@/api/client';
import { NAV_ITEMS } from '@/routes/nav';
import { Modal } from '@/components/ui/Modal';
import { useDebouncedValue } from '@/hooks/useServerList';

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  action: () => void;
}

/** Global search / jump-to: Ctrl/Cmd+K, filters routes and exposures. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  // Search runs server-side: the portfolio holds hundreds of exposures and the
  // palette should never need to download them all to match one borrower name.
  const search = useDebouncedValue(query.trim(), 250);

  const { data } = useQuery({
    queryKey: ['palette-exposures', search],
    queryFn: () =>
      api.portfolio.listExposures({
        page: 1,
        pageSize: 6,
        sortDir: 'desc',
        sortBy: 'grossCarryingAmount',
        search: search === '' ? undefined : search,
      } satisfies ListQuery),
    enabled: open && search.length > 0,
  });

  const items = useMemo<CommandItem[]>(() => {
    const q = search.toLowerCase();
    const pageItems: CommandItem[] = NAV_ITEMS.filter(
      (item) => !q || item.label.toLowerCase().includes(q),
    ).map((item) => ({
      id: item.to,
      label: item.label,
      hint: 'Page',
      action: () => navigate(item.to),
    }));
    const exposureItems: CommandItem[] = (data?.items ?? []).map((exposure) => ({
      id: exposure.id,
      label: `${exposure.publicId} — ${exposure.borrowerName}`,
      hint: `Exposure · Stage ${exposure.currentStage}`,
      action: () => navigate(`/portfolio/${exposure.publicId}`),
    }));
    return [...exposureItems, ...pageItems].slice(0, 12);
  }, [search, data, navigate]);

  const go = (item: CommandItem) => {
    item.action();
    setQuery('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Global search" size="md">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && items.length > 0) go(items[0]);
            }}
            placeholder="Search pages or exposures (e.g. EX-1007)…"
            className="h-10 w-full rounded-lg border border-line bg-surface-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand/25"
            aria-label="Search pages or exposures"
          />
        </div>
        <ul className="max-h-72 divide-y divide-line-soft overflow-y-auto rounded-xl border border-line">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-500">
              No matches for “{query}”.
            </li>
          ) : (
            items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => go(item)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900"
                >
                  <span className="truncate">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                    {item.hint}
                    <CornerDownLeft className="h-3 w-3" />
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Modal>
  );
}
