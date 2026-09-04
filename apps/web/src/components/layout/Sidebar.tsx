import { NavLink, useLocation } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV_ITEMS, NAV_SECTIONS } from '@/routes/nav';
import { useSettings } from '@/providers/SettingsProvider';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandMark } from './BrandMark';
import { cn } from '@/lib/utils';

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex h-16 items-center gap-2.5 border-b border-white/10 px-4',
        collapsed && 'justify-center px-0',
      )}
    >
      <BrandMark className="h-9 w-9 shrink-0" />
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">ECLens AI</p>
          <p className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-teal-300/70">
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
    <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-5">
      {NAV_SECTIONS.map((section) => {
        const items = NAV_ITEMS.filter((item) => item.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section}>
            {!collapsed ? (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">
                {section}
              </p>
            ) : (
              <div className="mx-auto mb-2 h-px w-6 bg-white/10" aria-hidden />
            )}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active =
                  location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
                const link = (
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    className={cn(
                      'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-white/[0.09] font-medium text-white'
                        : 'text-white/60 hover:bg-white/[0.05] hover:text-white',
                    )}
                  >
                    {/* Active rail: a lit edge is a cheaper signal than a heavy
                        filled block, and survives the collapsed rail width. */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-teal-400 transition-opacity',
                        active ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <item.icon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        active ? 'text-teal-300' : 'text-white/45 group-hover:text-teal-300',
                      )}
                    />
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

/**
 * Desktop sidebar with persisted collapsed state. The chrome is deliberately
 * always-dark (`ink`) in both themes — it anchors the app frame and keeps the
 * brand constant when the workspace flips to dark.
 */
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useSettings();
  return (
    <aside
      className={cn(
        'ink-canvas sticky top-0 hidden h-screen shrink-0 flex-col bg-ink transition-[width] duration-200 lg:flex',
        sidebarCollapsed ? 'w-[4.5rem]' : 'w-64',
      )}
    >
      <Brand collapsed={sidebarCollapsed} />
      <NavList collapsed={sidebarCollapsed} />
      <div className="border-t border-white/10 p-2.5">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
          {!sidebarCollapsed ? 'Collapse' : null}
        </button>
      </div>
    </aside>
  );
}

/** Navigation content reused inside the mobile drawer. */
export function MobileNav({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="ink-canvas flex h-full flex-col bg-ink">
      <Brand collapsed={false} />
      <NavList collapsed={false} onNavigate={onNavigate} />
    </div>
  );
}
