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
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center"
      role="alert"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-600 ring-1 ring-inset ring-red-500/20">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
          {description}
        </p>
      </div>
      {onRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          icon={<RotateCcw className="h-3.5 w-3.5" />}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
