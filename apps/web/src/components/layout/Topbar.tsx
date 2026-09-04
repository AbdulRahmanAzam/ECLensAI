import { Menu, Search } from 'lucide-react';
import { StartGuidedDemoButton } from '@/components/demo/StartGuidedDemoButton';
import { SyntheticBadge } from '@/components/ui/Badge';
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

export interface TopbarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
}

export function Topbar({ onMenuClick, onSearchClick }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur-xl md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <BrandMark className="h-8 w-8 lg:hidden" />

      <button
        type="button"
        onClick={onSearchClick}
        className="group flex h-9 w-full max-w-xs items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm text-slate-400 transition-colors hover:border-slate-300 hover:bg-surface hover:text-slate-600 md:max-w-sm"
        aria-label="Open global search"
      >
        <Search className="h-4 w-4" />
        <span className="hidden flex-1 text-left sm:block">Search or jump to…</span>
        <kbd className="ml-auto hidden rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500 md:inline">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2 md:gap-3">
        <span className="hidden lg:inline-flex">
          <SyntheticBadge />
        </span>
        <StartGuidedDemoButton />
        <ThemeToggle />
        <span className="hidden h-6 w-px bg-line sm:block" aria-hidden />
        <UserMenu />
      </div>
    </header>
  );
}
