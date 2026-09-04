import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { ROUTE_TITLES } from '@/routes/nav';

/** Path-derived breadcrumbs; unknown segments (IDs) render verbatim. */
export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const crumbs = segments.map((segment, index) => {
    const path = `/${segments.slice(0, index + 1).join('/')}`;
    return { label: ROUTE_TITLES[path] ?? segment, path };
  });

  return (
    <nav aria-label="Breadcrumb" className="mb-5">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <li>
          <Link
            to="/dashboard"
            className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-slate-800"
          >
            <Home className="h-3 w-3" aria-hidden />
            <span className="sr-only sm:not-sr-only">Home</span>
          </Link>
        </li>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={crumb.path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-slate-300" aria-hidden />
              {isLast ? (
                <span className="font-medium text-slate-800">{crumb.label}</span>
              ) : (
                <Link
                  to={crumb.path}
                  className="rounded px-1 py-0.5 transition-colors hover:text-slate-800"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
