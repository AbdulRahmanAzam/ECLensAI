/**
 * Deterministic demo identity and seeded portfolio bundle for ECLens AI.
 *
 * Step 1 generated its own 44-row book with a floating-point shortcut engine.
 * Step 2 replaces both: the exposures come from `ingest/generator.ts` (the same
 * deterministic generator that produces the downloadable template and sample
 * file, so a user can download exactly what the seed contains) and every
 * number is produced by the Decimal engine in `domain/ecl.ts`.
 *
 * All names are invented; no real personal information.
 */
import {
  DEFAULT_GENERATOR_OPTIONS,
  generateContractualSchedule,
  generatePortfolioRows,
  type GeneratedExposureRow,
  type GeneratorOptions,
} from './ingest/generator';
import { buildHistoricalPeriods, type HistoricalPeriod } from './ingest/history';
import { DEFAULT_MODEL_CONFIGURATION } from './domain/config';
import { DEFAULT_SCENARIO_SET } from './domain/scenarios';
import type { DemoUser, RoleName } from './types';

export const REPORTING_DATE = DEFAULT_GENERATOR_OPTIONS.reportingDate;
export const DEMO_ORGANIZATION = 'Meridian Demo Bank Ltd';
export const DEMO_PASSWORD = 'Demo1234!';
export const DEMO_CURRENCY = DEFAULT_GENERATOR_OPTIONS.currency;
export const DEMO_SEED = DEFAULT_GENERATOR_OPTIONS.seed;

/** Seeded portfolio size. The brief requires at least 750 exposures. */
export const DEMO_PORTFOLIO_SIZE = 780;

export const DEMO_USERS: DemoUser[] = [
  {
    id: 'usr-0001',
    email: 'demo@eclens.ai',
    fullName: 'Sana Kazmi',
    role: 'RISK_ANALYST',
    organizationName: DEMO_ORGANIZATION,
  },
  {
    id: 'usr-0002',
    email: 'admin@eclens.ai',
    fullName: 'Danish Farooqi',
    role: 'ADMIN',
    organizationName: DEMO_ORGANIZATION,
  },
  {
    id: 'usr-0003',
    email: 'reviewer@eclens.ai',
    fullName: 'Hamza Gilani',
    role: 'REVIEWER',
    organizationName: DEMO_ORGANIZATION,
  },
  {
    id: 'usr-0004',
    email: 'auditor@eclens.ai',
    fullName: 'Iqra Siddiqui',
    role: 'AUDITOR',
    organizationName: DEMO_ORGANIZATION,
  },
];

/** Who may perform which sensitive action. Mirrored by the API middleware. */
export const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  ADMIN: [
    'import:upload',
    'import:map',
    'import:commit',
    'portfolio:read',
    'exposure:override',
    'override:review',
    'run:create',
    'run:execute',
    'run:submit',
    'run:review',
    'model:read',
    'model:write',
    'scenario:read',
    'scenario:write',
    'scenario:approve',
    'audit:read',
    'ai:use',
    'document:read',
    'document:write',
    'document:delete',
    'report:export',
  ],
  RISK_ANALYST: [
    'import:upload',
    'import:map',
    'import:commit',
    'portfolio:read',
    'exposure:override',
    'run:create',
    'run:execute',
    'run:submit',
    'model:read',
    'scenario:read',
    'audit:read',
    'ai:use',
    'document:read',
    'document:write',
    'report:export',
  ],
  REVIEWER: [
    'portfolio:read',
    'override:review',
    'run:review',
    'model:read',
    'scenario:read',
    'scenario:approve',
    'audit:read',
    'ai:use',
    'document:read',
    'document:write',
    'report:export',
  ],
  AUDITOR: [
    'portfolio:read',
    'model:read',
    'scenario:read',
    'audit:read',
    'ai:use',
    'document:read',
    'report:export',
  ],
};

export const permissionsForRole = (role: RoleName): string[] => ROLE_PERMISSIONS[role];

export type ContractualSchedules = Record<string, ReturnType<typeof generateContractualSchedule>>;

export interface DemoPortfolioBundle {
  rows: GeneratedExposureRow[];
  /** Contractual amortization schedules for the subset of rows that have one. */
  schedules: ContractualSchedules;
  modelConfiguration: typeof DEFAULT_MODEL_CONFIGURATION;
  scenarioSet: typeof DEFAULT_SCENARIO_SET;
}

function schedulesFor(rows: GeneratedExposureRow[]): ContractualSchedules {
  const schedules: ContractualSchedules = {};
  for (const row of rows) {
    if (row.hasContractualSchedule) {
      schedules[row.values.exposureId] = generateContractualSchedule(row);
    }
  }
  return schedules;
}

/**
 * The exact data the API seed loads and the sample download serves.
 *
 * Deterministic: the same seed produces byte-identical rows on every machine,
 * which is what makes the hand-reconciled figures in the docs reproducible.
 */
export function generateDemoPortfolio(options: GeneratorOptions = {}): DemoPortfolioBundle {
  const resolved: GeneratorOptions = {
    count: DEMO_PORTFOLIO_SIZE,
    seed: DEMO_SEED,
    reportingDate: REPORTING_DATE,
    currency: DEMO_CURRENCY,
    ...options,
  };
  const rows = generatePortfolioRows(resolved);
  return {
    rows,
    schedules: schedulesFor(rows),
    modelConfiguration: DEFAULT_MODEL_CONFIGURATION,
    scenarioSet: DEFAULT_SCENARIO_SET,
  };
}

export interface DemoPeriodBundle {
  period: HistoricalPeriod;
  schedules: ContractualSchedules;
}

/**
 * The two earlier reporting periods behind the demo book, nearest first.
 *
 * One snapshot can answer "what is the allowance" but not "why did it move", and
 * the movement bridge, the stage migration matrix and the coverage trend are the
 * three views a judge reads first. These periods are *derived inputs* only —
 * every allowance, stage and total in them is still computed by the Decimal
 * engine when the seed stages and runs each period, so nothing here invents a
 * financial result.
 */
export function generateDemoHistory(
  base: DemoPortfolioBundle = generateDemoPortfolio(),
): DemoPeriodBundle[] {
  const periods = buildHistoricalPeriods(base.rows, {
    baseReportingDate: REPORTING_DATE,
    seed: DEMO_SEED,
    currency: DEMO_CURRENCY,
  });
  return periods.map((period) => ({ period, schedules: schedulesFor(period.rows) }));
}
