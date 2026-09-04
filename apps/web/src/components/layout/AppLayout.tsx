import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
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
    <div className="flex min-h-screen">
      <Sidebar />

      <Drawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        title="Navigation"
      >
        <div className="-mx-5 -my-4 h-[calc(100%+2rem)]">
          <MobileNav onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenuClick={() => setMobileNavOpen(true)} onSearchClick={() => setPaletteOpen(true)} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">
          <Breadcrumbs />
          <Outlet />
        </main>
        <footer className="border-t border-slate-200 px-4 py-3 text-center text-[11px] text-slate-400 md:px-8">
          ECLens AI · All figures are synthetic demo data; AI output is advisory only.
        </footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GuidedDemoSpotlight />
    </div>
  );
}
