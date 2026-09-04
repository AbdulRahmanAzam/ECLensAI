import { NavLink, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { NAV_ITEMS, NAV_SECTIONS } from '@/routes/nav';
import { useSettings } from '@/providers/SettingsProvider';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-navy-900 px-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-navy-800 text-sm font-bold text-teal-400">
        E
      </div>
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">ECLens AI</p>
          <p className="truncate text-[10px] uppercase tracking-widest text-slate-400">
            Expected Credit Loss
          </p>
        </div>
      ) : null}
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-4">
      {NAV_SECTIONS.map((section) => {
        const items = NAV_ITEMS.filter((item) => item.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section}>
            {!collapsed ? (
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {section}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active =
                  location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
                const link = (
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-navy-800 font-medium text-white'
                        : 'text-slate-300 hover:bg-navy-900 hover:text-white',
                    )}
                  >
                    <item.icon className={cn('h-4 w-4 shrink-0', active ? 'text-teal-400' : 'text-slate-400 group-hover:text-teal-400')} />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  </NavLink>
                );
                return (
                  <li key={item.to}>
                    {collapsed ? <Tooltip content={item.label}>{link}</Tooltip> : link}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Desktop sidebar with persisted collapsed state. */
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useSettings();
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col bg-navy-950 transition-all lg:flex',
        sidebarCollapsed ? 'w-16' : 'w-60',
      )}
    >
      <Brand collapsed={sidebarCollapsed} />
      <NavList collapsed={sidebarCollapsed} />
      <div className="border-t border-navy-900 p-2">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-400 transition-colors hover:bg-navy-900 hover:text-white"
        >
          {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!sidebarCollapsed ? 'Collapse' : null}
        </button>
      </div>
    </aside>
  );
}

/** Navigation content reused inside the mobile drawer. */
export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex h-full flex-col bg-navy-950">
      <Brand collapsed={false} />
      <NavList collapsed={false} onNavigate={onNavigate} />
    </div>
  );
}
