import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { BrandMark } from '@/components/layout/BrandMark';

function FullScreenLoader() {
  return (
    <div className="app-canvas flex min-h-screen items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <BrandMark className="h-11 w-11" />
        <Loader2 className="h-5 w-5 animate-spin text-brand" aria-label="Restoring session" />
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
