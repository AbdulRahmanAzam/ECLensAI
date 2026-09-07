import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { GuidedDemoSpotlight } from '@/components/demo/GuidedDemoSpotlight';
import { Drawer } from '@/components/ui/Drawer';
import { Breadcrumbs } from './Breadcrumbs';
import { CommandPalette } from './CommandPalette';
import { MobileNav, Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Authenticated application frame: sidebar, topbar, breadcrumbs, palette. */
export function AppLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar />

      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} title="Navigation">
        <div className="-mx-5 -my-4 h-[calc(100%+2rem)]">
          <MobileNav onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </Drawer>

      <div className="app-canvas flex min-w-0 flex-1 flex-col">
        <Topbar
          onMenuClick={() => setMobileNavOpen(true)}
          onSearchClick={() => setPaletteOpen(true)}
        />
        <main className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-7 md:px-8 md:py-9">
          <Breadcrumbs />
          {/* Keyed on the path so each navigation replays the entrance — the
              transition is what tells you the view actually changed. */}
          <div key={location.pathname} className="animate-fade-up">
            <Outlet />
          </div>
        </main>
        <footer className="mt-4 border-t border-line/70 px-4 py-5 text-center text-2xs text-slate-400 md:px-8">
          ECLens AI · All figures are synthetic demo data; AI output is advisory only.
        </footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GuidedDemoSpotlight />
    </div>
  );
}
