import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Guided Demo — the judge-facing walkthrough (step 4, judge_mode).
 *
 * Every step names a real route in this app and, optionally, a real element
 * on it (`data-tour="..."`, matched at render time). The tour never fakes an
 * action or a screenshot: it navigates the router to the page an analyst
 * would actually use and narrates what to look at or click there. Progress
 * persists to `localStorage` so a page refresh mid-tour does not lose the
 * spot, and the tour never blocks normal use — every route and control stays
 * fully interactive underneath the spotlight.
 */
export interface DemoStep {
  id: string;
  title: string;
  body: string;
  /** Route to navigate to for this step. */
  route: string;
  /** `data-tour` value of the element to highlight, if any. */
  target?: string;
}

export const DEMO_STEPS: DemoStep[] = [
  {
    id: 'portfolio-arrives',
    title: '1. A new portfolio arrives',
    body: 'A risk analyst receives a new loan portfolio — 780 seeded exposures across consumer, SME, agriculture, microfinance and corporate. Imports start here: upload a CSV or XLSX, or use the seeded sample.',
    route: '/imports',
    target: 'tour-imports-upload',
  },
  {
    id: 'map-and-validate',
    title: '2. Map columns, catch errors before calculation',
    body: 'Column headers are mapped to the canonical data dictionary — Gemini suggests a mapping with a confidence score, which an analyst must confirm. Every row is validated; invalid rows are quarantined with a reason, never silently repaired.',
    route: '/imports',
    target: 'tour-imports-batches',
  },
  {
    id: 'deterministic-engine',
    title: '3. The deterministic engine stages and calculates',
    body: 'Every exposure is staged with a machine-readable reason, then ECL is calculated per scenario and period — marginal PD × LGD × EAD × discount factor, never a shortcut. Every result carries the exact model, scenario and staging-rule versions it was calculated under.',
    route: '/ecl-runs',
  },
  {
    id: 'ai-explains',
    title: '4. Gemini explains the change — without inventing figures',
    body: "The dashboard's executive commentary is drafted by Gemini, but every number in it is copied from this run's stored results — never recalculated or guessed. Ask the AI Copilot a follow-up question and watch it cite the same figures.",
    route: '/dashboard',
    target: 'tour-executive-commentary',
  },
  {
    id: 'scenario-lab',
    title: '5. Build a downside scenario',
    body: 'An analyst can draft a downside scenario from a macro narrative — Gemini proposes PD/LGD multipliers with a rationale, shown as a clearly-labelled proposal. Nothing takes effect until a person explicitly approves the new scenario version.',
    route: '/scenarios',
    target: 'tour-scenario-draft',
  },
  {
    id: 'review-and-report',
    title: '6. Review, approve, download an audit-ready report',
    body: "A reviewer other than the run's creator checks the calculation trace and assumptions, then approves. Once approved, a real PDF report — totals, stage breakdown, scenario weights, movements, model assumptions and approval history — can be generated and downloaded from that run.",
    route: '/ecl-runs',
    target: 'tour-run-report',
  },
];

interface GuidedDemoState {
  active: boolean;
  stepIndex: number;
}

const STORAGE_KEY = 'eclens.guidedDemo';

function loadState(): GuidedDemoState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { active: false, stepIndex: 0 };
    const parsed = JSON.parse(raw) as Partial<GuidedDemoState>;
    return {
      active: parsed.active === true,
      stepIndex:
        typeof parsed.stepIndex === 'number'
          ? Math.min(Math.max(parsed.stepIndex, 0), DEMO_STEPS.length - 1)
          : 0,
    };
  } catch {
    return { active: false, stepIndex: 0 };
  }
}

function persistState(state: GuidedDemoState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Per-viewer convenience only; a full or blocked store just means no resume on refresh.
  }
}

interface GuidedDemoContextValue {
  active: boolean;
  stepIndex: number;
  step: DemoStep | null;
  totalSteps: number;
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  restart: () => void;
}

const GuidedDemoContext = createContext<GuidedDemoContextValue | undefined>(undefined);

export function GuidedDemoProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<GuidedDemoState>(() => loadState());

  useEffect(() => persistState(state), [state]);

  const goToStep = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), DEMO_STEPS.length - 1);
      setState({ active: true, stepIndex: clamped });
      navigate(DEMO_STEPS[clamped].route);
    },
    [navigate],
  );

  const start = useCallback(() => goToStep(0), [goToStep]);
  const next = useCallback(() => {
    if (state.stepIndex >= DEMO_STEPS.length - 1) {
      setState({ active: false, stepIndex: 0 });
      return;
    }
    goToStep(state.stepIndex + 1);
  }, [state.stepIndex, goToStep]);
  const back = useCallback(() => goToStep(state.stepIndex - 1), [state.stepIndex, goToStep]);
  const skip = useCallback(() => setState({ active: false, stepIndex: 0 }), []);
  const restart = useCallback(() => goToStep(0), [goToStep]);

  const value = useMemo<GuidedDemoContextValue>(
    () => ({
      active: state.active,
      stepIndex: state.stepIndex,
      step: state.active ? DEMO_STEPS[state.stepIndex] : null,
      totalSteps: DEMO_STEPS.length,
      start,
      next,
      back,
      skip,
      restart,
    }),
    [state, start, next, back, skip, restart],
  );

  return <GuidedDemoContext.Provider value={value}>{children}</GuidedDemoContext.Provider>;
}

export function useGuidedDemo(): GuidedDemoContextValue {
  const context = useContext(GuidedDemoContext);
  if (!context) throw new Error('useGuidedDemo must be used within GuidedDemoProvider');
  return context;
}
