import { Menu, Search } from 'lucide-react';
import { StartGuidedDemoButton } from '@/components/demo/StartGuidedDemoButton';
import { SyntheticBadge } from '@/components/ui/Badge';
import { UserMenu } from './UserMenu';

export interface TopbarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
}

export function Topbar({ onMenuClick, onSearchClick }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="rounded-md p-1.5 text-slate-600 transition-colors hover:bg-slate-100 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <button
        type="button"
        onClick={onSearchClick}
        className="flex h-9 w-full max-w-xs items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-600 md:max-w-sm"
        aria-label="Open global search"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 md:inline">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden sm:inline-flex">
          <SyntheticBadge />
        </span>
        <StartGuidedDemoButton />
        <UserMenu />
      </div>
    </header>
  );
}
