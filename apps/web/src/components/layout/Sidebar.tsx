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
        'flex h-16 items-center gap-2.5 border-b border-white/[0.08] px-4',
        collapsed && 'justify-center px-0',
      )}
    >
      <BrandMark className="h-9 w-9 shrink-0" />
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">ECLens AI</p>
          <p className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-teal-300/60">
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
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-6">
      {NAV_SECTIONS.map((section) => {
        const items = NAV_ITEMS.filter((item) => item.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section}>
            {!collapsed ? (
              <p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">
                {section}
              </p>
            ) : (
              <div className="mx-auto mb-3 h-px w-6 bg-white/10" aria-hidden />
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
                      'group relative flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors duration-150',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-gradient-to-r from-white/[0.13] to-white/[0.05] font-medium text-white shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)]'
                        : 'text-white/55 hover:bg-white/[0.05] hover:text-white',
                    )}
                  >
                    {/* Active rail: a lit edge is a cheaper signal than a heavy
                        filled block, and survives the collapsed rail width. */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute -left-3 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-teal-400 transition-all duration-200',
                        active
                          ? 'opacity-100 shadow-[0_0_12px_0_rgb(45_212_191/0.6)]'
                          : 'opacity-0',
                      )}
                    />
                    <item.icon
                      className={cn(
                        'h-[1.05rem] w-[1.05rem] shrink-0 transition-colors',
                        active ? 'text-teal-300' : 'text-white/40 group-hover:text-teal-300',
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
 * Desktop sidebar with persisted collapsed state.
 *
 * The app ships light-only, and the navy rail is exactly why that works: it
 * frames the white workspace and carries the brand, so the content area is free
 * to stay quiet paper.
 */
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useSettings();
  return (
    <aside
      className={cn(
        'ink-canvas grain sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden bg-ink transition-[width] duration-200 lg:flex',
        sidebarCollapsed ? 'w-[4.5rem]' : 'w-[16.5rem]',
      )}
    >
      <Brand collapsed={sidebarCollapsed} />
      <NavList collapsed={sidebarCollapsed} />
      <div className="relative border-t border-white/[0.08] p-3">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-medium text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white"
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
    <div className="ink-canvas grain relative flex h-full flex-col overflow-hidden bg-ink">
      <Brand collapsed={false} />
      <NavList collapsed={false} onNavigate={onNavigate} />
    </div>
  );
}
