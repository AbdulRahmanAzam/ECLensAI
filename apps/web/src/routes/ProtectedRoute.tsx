import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-950 text-lg font-bold text-teal-400">
          E
        </div>
        <Loader2 className="h-5 w-5 animate-spin text-navy-500" aria-label="Restoring session" />
        <p className="text-xs text-slate-500">Restoring your session…</p>
      </div>
    </div>
  );
}

/** Guards authenticated routes and restores sessions on first load. */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <Outlet />;
}
