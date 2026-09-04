/**
 * Probability-of-default term structures and survival logic.
 *
 * IFRS 9 needs *non-overlapping marginal* default probabilities per period.
 * Suppliers report PD three different ways — cumulative, conditional (hazard)
 * or already marginal. This module converts all three into marginals using
 * survival logic and validates that the cumulative default probability never
 * exceeds 1.
 *
 * Survival identities used throughout:
 *   S(0)   = 1
 *   S(t)   = S(t-1) x (1 - h(t))          h = conditional/hazard PD
 *   m(t)   = S(t-1) - S(t) = S(t-1) x h(t)  m = marginal PD
 *   C(t)   = 1 - S(t)                       C = cumulative PD
 */
import { dec, one, zero, type Dec, type DecValue } from './decimal';
import { engineError } from './errors';

export const PD_BASES = ['MARGINAL', 'CONDITIONAL', 'CUMULATIVE'] as const;
export type PdBasis = (typeof PD_BASES)[number];

export interface PdTermStructurePointInput {
  /** 1-based period index, monthly by default. */
  period: number;
  /** PD expressed on the term structure's `basis`. */
  pd: DecValue;
}

export interface PdTermStructureInput {
  basis: PdBasis;
  points: PdTermStructurePointInput[];
}

export interface MarginalPdPoint {
  period: number;
  /** Probability of first default occurring exactly in this period. */
  marginalPd: Dec;
  /** Probability of defaulting in this period given survival to its start. */
  conditionalPd: Dec;
  /** Probability of surviving to the end of this period. */
  survival: Dec;
  /** Probability of having defaulted at or before the end of this period. */
  cumulativePd: Dec;
}

const assertProbability = (value: Dec, field: string): void => {
  if (!value.isFinite()) {
    throw engineError('PD_NEGATIVE', `${field} must be a finite probability`, [
      { field, observed: value.toString() },
    ]);
  }
  if (value.lessThan(zero())) {
    throw engineError('PD_NEGATIVE', `${field} cannot be negative`, [
      { field, observed: value.toString(), expected: '>= 0' },
    ]);
  }
  if (value.greaterThan(one())) {
    throw engineError('PD_CUMULATIVE_EXCEEDS_ONE', `${field} cannot exceed 1`, [
      { field, observed: value.toString(), expected: '<= 1' },
    ]);
  }
};

function assertContiguousPeriods(points: PdTermStructurePointInput[]): void {
  if (points.length === 0) {
    throw engineError('PD_TERM_STRUCTURE_EMPTY', 'A PD term structure needs at least one period');
  }
  points.forEach((point, index) => {
    if (!Number.isInteger(point.period) || point.period !== index + 1) {
      throw engineError('PD_TERM_STRUCTURE_GAPS', 'PD term structure periods must be 1..n with no gaps', [
        { field: 'period', observed: String(point.period), expected: String(index + 1) },
      ]);
    }
  });
}

/** Rebuilds marginal/cumulative/survival columns from conditional PDs. */
function fromConditional(points: PdTermStructurePointInput[]): MarginalPdPoint[] {
  const out: MarginalPdPoint[] = [];
  let survival = one();
  for (const point of points) {
    const conditional = dec(point.pd);
    assertProbability(conditional, `conditionalPd[${point.period}]`);
    const marginal = survival.times(conditional);
    survival = survival.minus(marginal);
    out.push({
      period: point.period,
      marginalPd: marginal,
      conditionalPd: conditional,
      survival,
      cumulativePd: one().minus(survival),
    });
  }
  return out;
}

/**
 * Converts any supported basis into non-overlapping marginal PDs and proves the
 * cumulative default probability stays within [0, 1].
 */
export function toMarginalPd(termStructure: PdTermStructureInput): MarginalPdPoint[] {
  const points = [...termStructure.points].sort((a, b) => a.period - b.period);
  assertContiguousPeriods(points);

  if (termStructure.basis === 'CONDITIONAL') return fromConditional(points);

  if (termStructure.basis === 'MARGINAL') {
    const out: MarginalPdPoint[] = [];
    let survival = one();
    let cumulative = zero();
    for (const point of points) {
      const marginal = dec(point.pd);
      assertProbability(marginal, `marginalPd[${point.period}]`);
      if (marginal.greaterThan(survival)) {
        throw engineError(
          'PD_CUMULATIVE_EXCEEDS_ONE',
          `Marginal PDs sum above 1 at period ${point.period}`,
          [
            {
              field: `marginalPd[${point.period}]`,
              observed: cumulative.plus(marginal).toString(),
              expected: '<= 1',
            },
          ],
        );
      }
      cumulative = cumulative.plus(marginal);
      survival = survival.minus(marginal);
      out.push({
        period: point.period,
        marginalPd: marginal,
        conditionalPd: survival.plus(marginal).isZero() ? zero() : marginal.dividedBy(survival.plus(marginal)),
        survival,
        cumulativePd: cumulative,
      });
    }
    return out;
  }

  // CUMULATIVE
  const out: MarginalPdPoint[] = [];
  let previousCumulative = zero();
  for (const point of points) {
    const cumulative = dec(point.pd);
    assertProbability(cumulative, `cumulativePd[${point.period}]`);
    if (cumulative.lessThan(previousCumulative)) {
      throw engineError(
        'PD_CUMULATIVE_NOT_MONOTONIC',
        `Cumulative PD must be non-decreasing; period ${point.period} (${cumulative.toString()}) is below period ${point.period - 1} (${previousCumulative.toString()})`,
        [
          {
            field: `cumulativePd[${point.period}]`,
            observed: cumulative.toString(),
            expected: `>= ${previousCumulative.toString()}`,
          },
        ],
      );
    }
    const marginal = cumulative.minus(previousCumulative);
    const survival = one().minus(cumulative);
    out.push({
      period: point.period,
      marginalPd: marginal,
      conditionalPd: survival.plus(marginal).isZero() ? zero() : marginal.dividedBy(survival.plus(marginal)),
      survival,
      cumulativePd: cumulative,
    });
    previousCumulative = cumulative;
  }
  return out;
}

/**
 * Applies a macro-scenario PD multiplier in *hazard space* and rebuilds the
 * marginals from survival logic.
 *
 * Scaling marginals directly can push the cumulative PD above 1 under severe
 * downside scenarios. Scaling the conditional PD (capped at 1) and recomputing
 * survival keeps every cumulative PD <= 1 by construction, which is both
 * mathematically sound and deterministic.
 */
export function scaleMarginalPd(points: MarginalPdPoint[], pdMultiplier: DecValue): MarginalPdPoint[] {
  const factor = dec(pdMultiplier);
  if (!factor.isFinite() || factor.lessThanOrEqualTo(zero())) {
    throw engineError('SCENARIO_FACTOR_INVALID', 'PD multiplier must be a finite number > 0', [
      { field: 'pdMultiplier', observed: factor.toString(), expected: '> 0' },
    ]);
  }
  const scaledConditional = points.map((point) => ({
    period: point.period,
    pd: factor.times(point.conditionalPd).greaterThan(one()) ? one() : factor.times(point.conditionalPd),
  }));
  return fromConditional(scaledConditional);
}

/** Sums marginal PDs across a period window (used for reported lifetime PD). */
export function cumulativePdOver(points: MarginalPdPoint[], fromPeriod = 1, toPeriod?: number): Dec {
  const end = toPeriod ?? points.length;
  return points
    .filter((point) => point.period >= fromPeriod && point.period <= end)
    .reduce((total, point) => total.plus(point.marginalPd), zero());
}

/**
 * Derives a monthly term structure from the two PDs most institutions report:
 * a 12-month PD and a lifetime PD over the remaining contractual term.
 *
 * A flat (level) hazard is assumed inside each block, which is the standard
 * interpolation when only two anchor points are available:
 *   Block 1 (periods 1..w):   h1 = 1 - (1 - pd12)^(1/w)
 *   Block 2 (periods w+1..T): h2 = 1 - ((1 - pdLife)/(1 - pd12))^(1/(T-w))
 * where w = min(12, T). This is a documented modelling assumption, not a
 * regulatory judgment, and it is versioned with the model configuration.
 *
 * When the remaining term is 12 months or less the lifetime PD is the only
 * anchor used, because a 12-month PD and a lifetime PD then cover the same
 * window.
 */
export function deriveTermStructureFromAnchors(options: {
  twelveMonthPd: DecValue;
  lifetimePd: DecValue;
  remainingMonths: number;
  /** Length of the near-term window, normally 12. */
  twelveMonthWindow?: number;
  /** PDs are clamped into this range before interpolation. */
  pdFloor?: DecValue;
  pdCeiling?: DecValue;
}): MarginalPdPoint[] {
  const floor = dec(options.pdFloor ?? '0.0001');
  const ceiling = dec(options.pdCeiling ?? '0.9999');
  const clamp = (value: Dec): Dec => (value.lessThan(floor) ? floor : value.greaterThan(ceiling) ? ceiling : value);

  const pd12 = clamp(dec(options.twelveMonthPd));
  const pdLife = clamp(dec(options.lifetimePd));
  const total = options.remainingMonths;

  if (!Number.isInteger(total) || total < 1) {
    throw engineError('INVALID_HORIZON', 'Remaining contractual term must be at least 1 month', [
      { field: 'remainingMonths', observed: String(total), expected: '>= 1' },
    ]);
  }

  const window = Math.min(options.twelveMonthWindow ?? 12, total);
  const shortLife = total <= window;

  if (!shortLife && pdLife.lessThan(pd12)) {
    throw engineError(
      'PD_TERM_STRUCTURE_INCONSISTENT',
      `Lifetime PD (${pdLife.toString()}) cannot be below the 12-month PD (${pd12.toString()}) over a ${total}-month term`,
      [
        { field: 'lifetimePd', observed: pdLife.toString(), expected: `>= ${pd12.toString()}` },
      ],
    );
  }

  const anchorNear = shortLife ? pdLife : pd12;
  const survivalNear = one().minus(anchorNear);
  const hazardNear = one().minus(survivalNear.pow(dec(1).dividedBy(window)));

  const points: PdTermStructurePointInput[] = [];
  for (let period = 1; period <= window; period += 1) {
    points.push({ period, pd: hazardNear });
  }

  if (!shortLife) {
    const tailPeriods = total - window;
    const survivalTail = one().minus(pdLife);
    const ratio = survivalTail.dividedBy(survivalNear);
    const hazardTail = one().minus(ratio.pow(dec(1).dividedBy(tailPeriods)));
    for (let period = window + 1; period <= total; period += 1) {
      points.push({ period, pd: hazardTail });
    }
  }

  return fromConditional(points);
}
