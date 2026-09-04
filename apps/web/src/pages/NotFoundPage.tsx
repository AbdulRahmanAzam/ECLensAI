import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-card">
        <EmptyState
          icon={<Compass className="h-8 w-8" />}
          title="Page not found"
          description="The page you are looking for does not exist or has been moved. Check the address, or return to the dashboard."
          action={
            <Link to="/dashboard">
              <Button size="sm">Go to dashboard</Button>
            </Link>
          }
        />
      </div>
    </div>
  );
}
