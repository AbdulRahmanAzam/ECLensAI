import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, UserRound } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/components/ui/Toast';

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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-slate-100"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-800 text-[11px] font-semibold text-white">
          {initials(user.fullName)}
        </span>
        <span className="hidden text-left md:block">
          <span className="block text-xs font-medium text-slate-800">{user.fullName}</span>
          <span className="block text-[10px] text-slate-500">{user.role.replace('_', ' ')}</span>
        </span>
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
            className="absolute right-0 z-50 mt-1.5 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-pop"
          >
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="text-xs font-medium text-slate-800">{user.fullName}</p>
              <p className="text-[11px] text-slate-500">{user.email}</p>
              <p className="mt-1 text-[11px] text-slate-500">{user.organizationName}</p>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/settings');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <UserRound className="h-3.5 w-3.5 text-slate-400" /> Profile & preferences
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/settings');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Settings className="h-3.5 w-3.5 text-slate-400" /> Organization settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
