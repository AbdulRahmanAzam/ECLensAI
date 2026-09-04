import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, RotateCcw, Sparkles, X } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/providers/AuthProvider';
import { useGuidedDemo } from '@/providers/GuidedDemoProvider';

/**
 * Two clicks, not a native `confirm()` dialog (which would block the whole
 * extension/tab): the first click arms a 4-second confirmation window: the
 * second click, taken within it, is what actually fires the reset.
 */
function useArmedAction(
  onConfirm: () => void,
  windowMs = 4000,
): { armed: boolean; trigger: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), windowMs);
    return () => window.clearTimeout(timer);
  }, [armed, windowMs]);

  const trigger = () => {
    if (armed) {
      setArmed(false);
      onConfirm();
    } else {
      setArmed(true);
    }
  };
  return { armed, trigger };
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Polls for the step's target element, since it may not exist yet right after a route change. */
function useTargetRect(target: string | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let frame: number;

    const measure = () => {
      const element = document.querySelector(`[data-tour="${target}"]`);
      if (element) {
        const box = element.getBoundingClientRect();
        if (!cancelled)
          setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (!cancelled) {
        setRect(null);
      }
      frame = window.requestAnimationFrame(measure);
    };
    frame = window.requestAnimationFrame(measure);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [target]);

  return rect;
}

/**
 * Non-blocking overlay: a highlight ring (pointer-events disabled, so the
 * real control underneath stays fully clickable) plus a floating panel with
 * the step's narration and Back/Next/Skip. Nothing here intercepts a click
 * on the app itself — closing the tour is the only way to lose it.
 */
export function GuidedDemoSpotlight() {
  const { active, step, stepIndex, totalSteps, next, back, skip, restart } = useGuidedDemo();
  const { user } = useAuth();
  const { push } = useToast();
  const rect = useTargetRect(step?.target);
  const panelRef = useRef<HTMLDivElement>(null);

  const reset = useMutation({
    mutationFn: () => api.demo.reset(),
    onSuccess: () => {
      // Every id the client holds — session, cached queries — is now stale;
      // a full reload is correct here, not a router navigation.
      window.location.href = '/login';
    },
    onError: () =>
      push('error', 'Reset failed', 'The demo data reset did not complete. Try again.'),
  });
  const resetAction = useArmedAction(() => reset.mutate());

  useEffect(() => {
    if (active) panelRef.current?.focus();
  }, [active, stepIndex]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, next, back, skip]);

  if (!active || !step) return null;

  return (
    <>
      {rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 rounded-lg ring-4 ring-teal-500 ring-offset-2 transition-all duration-300"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      ) : null}

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="guided-demo-title"
        tabIndex={-1}
        className="fixed bottom-5 right-5 z-50 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-lg border border-navy-100 bg-surface p-4 shadow-pop focus:outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2 py-0.5 text-2xs font-medium text-teal-800">
            <Sparkles className="h-3 w-3" /> Guided Demo · Step {stepIndex + 1} of {totalSteps}
          </span>
          <button
            type="button"
            onClick={skip}
            aria-label="Skip guided demo"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <h2 id="guided-demo-title" className="mt-2 text-sm font-semibold text-navy-950">
          {step.title}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft className="h-3.5 w-3.5" />}
            disabled={stepIndex === 0}
            onClick={back}
          >
            Back
          </Button>
          <Button
            size="sm"
            className="ml-auto"
            icon={stepIndex < totalSteps - 1 ? <ArrowRight className="h-3.5 w-3.5" /> : undefined}
            onClick={next}
          >
            {stepIndex < totalSteps - 1 ? 'Next' : 'Finish'}
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={restart}
            className="text-2xs font-medium text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500"
          >
            Restart from step 1
          </button>
          {user?.role === 'ADMIN' ? (
            <button
              type="button"
              onClick={resetAction.trigger}
              disabled={reset.isPending}
              className="inline-flex items-center gap-1 text-2xs font-medium text-slate-400 underline-offset-2 hover:text-red-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              {reset.isPending
                ? 'Resetting… (about 2 minutes)'
                : resetAction.armed
                  ? 'Confirm: wipe & reseed all data'
                  : 'Reset demo data'}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
