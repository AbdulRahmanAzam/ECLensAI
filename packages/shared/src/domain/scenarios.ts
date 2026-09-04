/**
 * Macro-economic scenario sets.
 *
 * Base / upside / downside are the default trio, but any number of additional
 * scenarios is allowed. Weights must be non-negative and the *active* weights
 * must total exactly 1 within a safe decimal tolerance — checked with Decimal
 * arithmetic, never binary floating point.
 */
import {
  dec,
  decCloseTo,
  one,
  zero,
  WEIGHT_SUM_TOLERANCE,
  type Dec,
  type DecValue,
} from './decimal';
import { engineError } from './errors';
import type { MacroIndicators } from '../types';

export interface ScenarioDefinitionInput {
  /** Stable machine code, e.g. BASE, UPSIDE, DOWNSIDE, SEVERE_DOWNSIDE. */
  code: string;
  name: string;
  weight: DecValue;
  /** Multiplies the conditional PD term structure in hazard space. */
  pdMultiplier: DecValue;
  /** Multiplies the point-in-time LGD before floor/ceiling clamping. */
  lgdMultiplier: DecValue;
  isActive: boolean;
  description?: string;
  indicators?: MacroIndicators;
}

export interface ScenarioSetInput {
  id: string;
  name: string;
  version: string;
  scenarios: ScenarioDefinitionInput[];
}

export interface ResolvedScenario {
  code: string;
  name: string;
  weight: Dec;
  pdMultiplier: Dec;
  lgdMultiplier: Dec;
  isActive: boolean;
  description: string;
  indicators: MacroIndicators | null;
}

export interface ResolvedScenarioSet {
  id: string;
  name: string;
  version: string;
  scenarios: ResolvedScenario[];
  /** Active scenarios only, in declaration order. This is what the engine sums over. */
  activeScenarios: ResolvedScenario[];
  weightTotal: Dec;
}

const positive = (value: DecValue, field: string, code: 'SCENARIO_WEIGHT_NEGATIVE' | 'SCENARIO_FACTOR_INVALID'): void => {
  const decValue = dec(value);
  if (!decValue.isFinite()) {
    throw engineError(code, `${field} must be a finite number`, [
      { field, observed: decValue.toString() },
    ]);
  }
};

/**
 * Validates a scenario set and resolves every value to a Decimal.
 * Throws with a stable error code on any violation; never repairs the set.
 */
export function resolveScenarioSet(
  input: ScenarioSetInput,
  tolerance: DecValue = WEIGHT_SUM_TOLERANCE,
): ResolvedScenarioSet {
  if (!input.id || !input.version) {
    throw engineError('SCENARIO_SET_EMPTY', 'A scenario set requires an id and a version');
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    throw engineError('SCENARIO_SET_EMPTY', 'A scenario set requires at least one scenario');
  }

  const seen = new Set<string>();
  const scenarios: ResolvedScenario[] = input.scenarios.map((scenario) => {
    const code = scenario.code.trim().toUpperCase();
    if (code.length === 0) {
      throw engineError('SCENARIO_SET_EMPTY', 'Every scenario requires a non-empty code');
    }
    if (seen.has(code)) {
      throw engineError('SCENARIO_CODE_DUPLICATE', `Duplicate scenario code '${code}'`, [
        { field: 'code', observed: code },
      ]);
    }
    seen.add(code);

    positive(scenario.weight, `weight[${code}]`, 'SCENARIO_WEIGHT_NEGATIVE');
    const weight = dec(scenario.weight);
    if (weight.lessThan(zero())) {
      throw engineError('SCENARIO_WEIGHT_NEGATIVE', `Scenario '${code}' has a negative weight`, [
        { field: `weight[${code}]`, observed: weight.toString(), expected: '>= 0' },
      ]);
    }

    positive(scenario.pdMultiplier, `pdMultiplier[${code}]`, 'SCENARIO_FACTOR_INVALID');
    positive(scenario.lgdMultiplier, `lgdMultiplier[${code}]`, 'SCENARIO_FACTOR_INVALID');
    const pdMultiplier = dec(scenario.pdMultiplier);
    const lgdMultiplier = dec(scenario.lgdMultiplier);
    if (pdMultiplier.lessThanOrEqualTo(zero()) || lgdMultiplier.lessThanOrEqualTo(zero())) {
      throw engineError(
        'SCENARIO_FACTOR_INVALID',
        `Scenario '${code}' multipliers must be greater than 0`,
        [
          { field: `pdMultiplier[${code}]`, observed: pdMultiplier.toString(), expected: '> 0' },
          { field: `lgdMultiplier[${code}]`, observed: lgdMultiplier.toString(), expected: '> 0' },
        ],
      );
    }

    return {
      code,
      name: scenario.name.trim() || code,
      weight,
      pdMultiplier,
      lgdMultiplier,
      isActive: scenario.isActive,
      description: scenario.description?.trim() ?? '',
      indicators: scenario.indicators ?? null,
    };
  });

  const activeScenarios = scenarios.filter((scenario) => scenario.isActive);
  if (activeScenarios.length === 0) {
    throw engineError('SCENARIO_SET_EMPTY', 'At least one scenario must be active');
  }

  const weightTotal = activeScenarios.reduce((total, scenario) => total.plus(scenario.weight), zero());
  if (!decCloseTo(weightTotal, one(), tolerance)) {
    throw engineError(
      'SCENARIO_WEIGHTS_NOT_NORMALIZED',
      `Active scenario weights must total exactly 1 (tolerance ${dec(tolerance).toString()}); they total ${weightTotal.toString()}`,
      [{ field: 'weightTotal', observed: weightTotal.toString(), expected: '1' }],
    );
  }

  return {
    id: input.id,
    name: input.name,
    version: input.version,
    scenarios,
    activeScenarios,
    weightTotal,
  };
}

/** Default base/upside/downside trio used by the seed and the template. */
export const DEFAULT_SCENARIO_SET: ScenarioSetInput = {
  id: 'scs-pkr-core',
  name: 'Pakistan macro base case',
  version: '1.0.0',
  scenarios: [
    {
      code: 'BASE',
      name: 'Base',
      weight: '0.5',
      pdMultiplier: '1.0',
      lgdMultiplier: '1.0',
      isActive: true,
      description:
        'Central forecast: modest GDP recovery, inflation easing toward the policy target, stable policy rate.',
      indicators: {
        gdpGrowth: 0.027,
        inflationRate: 0.075,
        unemploymentRate: 0.062,
        policyRate: 0.135,
      },
    },
    {
      code: 'UPSIDE',
      name: 'Upside',
      weight: '0.2',
      pdMultiplier: '0.75',
      lgdMultiplier: '0.92',
      isActive: true,
      description:
        'Favourable path: faster growth, disinflation, policy easing and improved collateral recovery values.',
      indicators: {
        gdpGrowth: 0.045,
        inflationRate: 0.052,
        unemploymentRate: 0.054,
        policyRate: 0.105,
      },
    },
    {
      code: 'DOWNSIDE',
      name: 'Downside',
      weight: '0.3',
      pdMultiplier: '1.45',
      lgdMultiplier: '1.08',
      isActive: true,
      description:
        'Adverse path: currency and fiscal stress, renewed inflation, tighter policy rate and weaker recoveries.',
      indicators: {
        gdpGrowth: -0.011,
        inflationRate: 0.168,
        unemploymentRate: 0.081,
        policyRate: 0.185,
      },
    },
  ],
};
