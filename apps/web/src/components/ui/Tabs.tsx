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
      <div role="tablist" className="flex gap-1 border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === activeTab?.id}
            onClick={() => select(tab.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab.id === activeTab?.id
                ? 'border-navy-700 text-navy-800'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="pt-4">
        {activeTab?.content}
      </div>
    </div>
  );
}
