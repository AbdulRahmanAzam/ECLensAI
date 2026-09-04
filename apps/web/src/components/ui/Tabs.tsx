import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  value?: string;
  onChange?: (id: string) => void;
  defaultTab?: string;
}

/** Segmented control. The active pill is a filled surface, not an underline. */
export function Tabs({ tabs, value, onChange, defaultTab }: TabsProps) {
  const [internal, setInternal] = useState(defaultTab ?? tabs[0]?.id ?? '');
  const active = value ?? internal;

  const select = (id: string) => {
    setInternal(id);
    onChange?.(id);
  };

  const activeTab = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div>
      <div
        role="tablist"
        className="inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === activeTab?.id}
            onClick={() => select(tab.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
              tab.id === activeTab?.id
                ? 'bg-surface text-slate-900 shadow-xs'
                : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="animate-fade-in pt-4">
        {activeTab?.content}
      </div>
    </div>
  );
}
