import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const handleLogout = async () => {
    await logout();
    push('info', 'Signed out', 'Your session has ended.');
    navigate('/login');
  };

  const menuItem =
    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-transparent px-1 py-1 transition-colors hover:border-line hover:bg-surface-2"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-ink-3 to-ink text-2xs font-semibold text-white ring-1 ring-inset ring-white/15">
          {initials(user.fullName)}
        </span>
        <span className="hidden text-left md:block">
          <span className="block text-xs font-medium text-slate-800">{user.fullName}</span>
          <span className="block text-[10px] capitalize text-slate-500">
            {user.role.replace('_', ' ').toLowerCase()}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'hidden h-3.5 w-3.5 text-slate-400 transition-transform md:block',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
          />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-60 animate-scale-in overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop"
          >
            <div className="border-b border-line-soft px-3 py-2.5">
              <p className="text-xs font-semibold text-slate-900">{user.fullName}</p>
              <p className="truncate text-2xs text-slate-500">{user.email}</p>
              <p className="mt-1 text-2xs text-slate-500">{user.organizationName}</p>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/settings');
              }}
              className={menuItem}
            >
              <UserRound className="h-3.5 w-3.5 text-slate-400" /> Profile &amp; preferences
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/settings');
              }}
              className={menuItem}
            >
              <Settings className="h-3.5 w-3.5 text-slate-400" /> Organization settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex w-full items-center gap-2.5 border-t border-line-soft px-3 py-2 text-left text-xs text-red-600 transition-colors hover:bg-red-50"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
