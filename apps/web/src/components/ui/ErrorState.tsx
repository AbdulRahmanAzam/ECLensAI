import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'The data could not be loaded. Try again, or contact your administrator if the problem persists.',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" role="alert">
      <span className="text-red-400">
        <AlertTriangle className="h-8 w-8" />
      </span>
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      <p className="max-w-sm text-xs text-slate-500">{description}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} icon={<RotateCcw className="h-3.5 w-3.5" />}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
