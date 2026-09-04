/**
 * required_tests[3] — survival and marginal PD conversion.
 *
 * The identities under test are the ones documented in `domain/pd.ts`:
 *   S(0) = 1
 *   S(t) = S(t-1) x (1 - h(t))
 *   m(t) = S(t-1) - S(t) = S(t-1) x h(t)
 *   C(t) = 1 - S(t)
 */
import { describe, expect, it } from 'vitest';
import {
  cumulativePdOver,
  dec,
  deriveTermStructureFromAnchors,
  one,
  scaleMarginalPd,
  toMarginalPd,
  zero,
  type PdTermStructureInput,
} from '../src/index';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
};

const structure = (basis: PdTermStructureInput['basis'], pds: string[]): PdTermStructureInput => ({
  basis,
  points: pds.map((pd, index) => ({ period: index + 1, pd })),
});

describe('toMarginalPd — CONDITIONAL basis (survival logic)', () => {
  // h = 1% every period: m(t) = 0.99^(t-1) x 0.01, all exact decimals.
  const points = toMarginalPd(structure('CONDITIONAL', ['0.01', '0.01', '0.01']));

  it('produces the hand-checkable marginal / survival / cumulative columns', () => {
    expect(points.map((p) => p.marginalPd.toString())).toEqual(['0.01', '0.0099', '0.009801']);
    expect(points.map((p) => p.survival.toString())).toEqual(['0.99', '0.9801', '0.970299']);
    expect(points.map((p) => p.cumulativePd.toString())).toEqual(['0.01', '0.0199', '0.029701']);
  });

  it('holds S(t) = S(t-1) - m(t) and C(t) = 1 - S(t) on every row', () => {
    let previousSurvival = one();
    for (const point of points) {
      expect(point.survival.toString()).toEqual(previousSurvival.minus(point.marginalPd).toString());
      expect(point.cumulativePd.toString()).toEqual(one().minus(point.survival).toString());
      expect(point.marginalPd.toString()).toEqual(previousSurvival.times(point.conditionalPd).toString());
      previousSurvival = point.survival;
    }
  });

  it('never lets cumulative PD exceed 1 even when every period is certain', () => {
    const certain = toMarginalPd(structure('CONDITIONAL', ['1', '1', '1']));
    expect(certain.map((p) => p.marginalPd.toString())).toEqual(['1', '0', '0']);
    expect(certain[2].cumulativePd.toString()).toEqual('1');
  });
});

describe('toMarginalPd — MARGINAL basis', () => {
  it('passes non-overlapping marginals through unchanged', () => {
    const points = toMarginalPd(structure('MARGINAL', ['0.01', '0.02', '0.03']));
    expect(points.map((p) => p.marginalPd.toString())).toEqual(['0.01', '0.02', '0.03']);
    expect(points.map((p) => p.cumulativePd.toString())).toEqual(['0.01', '0.03', '0.06']);
    expect(points[2].survival.toString()).toEqual('0.94');
  });

  it('rejects marginals that sum above 1', () => {
    expect(codeOf(() => toMarginalPd(structure('MARGINAL', ['0.6', '0.5'])))).toEqual(
      'PD_CUMULATIVE_EXCEEDS_ONE',
    );
  });
});

describe('toMarginalPd — CUMULATIVE basis', () => {
  it('differences consecutive cumulative PDs into marginals', () => {
    const points = toMarginalPd(structure('CUMULATIVE', ['0.01', '0.03', '0.06']));
    expect(points.map((p) => p.marginalPd.toString())).toEqual(['0.01', '0.02', '0.03']);
    expect(points.map((p) => p.survival.toString())).toEqual(['0.99', '0.97', '0.94']);
  });

  it('rejects a decreasing cumulative curve', () => {
    expect(codeOf(() => toMarginalPd(structure('CUMULATIVE', ['0.05', '0.04'])))).toEqual(
      'PD_CUMULATIVE_NOT_MONOTONIC',
    );
  });

  it('rejects a cumulative PD above 1', () => {
    expect(codeOf(() => toMarginalPd(structure('CUMULATIVE', ['0.5', '1.2'])))).toEqual(
      'PD_CUMULATIVE_EXCEEDS_ONE',
    );
  });
});

describe('toMarginalPd — structural rejections', () => {
  it('rejects an empty term structure', () => {
    expect(codeOf(() => toMarginalPd({ basis: 'CONDITIONAL', points: [] }))).toEqual(
      'PD_TERM_STRUCTURE_EMPTY',
    );
  });

  it('rejects gaps in the period index', () => {
    expect(
      codeOf(() =>
        toMarginalPd({
          basis: 'CONDITIONAL',
          points: [
            { period: 1, pd: '0.01' },
            { period: 3, pd: '0.01' },
          ],
        }),
      ),
    ).toEqual('PD_TERM_STRUCTURE_GAPS');
  });

  it('rejects a negative probability', () => {
    expect(codeOf(() => toMarginalPd(structure('CONDITIONAL', ['0.01', '-0.02'])))).toEqual(
      'PD_NEGATIVE',
    );
  });
});

describe('scaleMarginalPd — scenario multipliers applied in hazard space', () => {
  const base = toMarginalPd(structure('CONDITIONAL', ['0.01', '0.01', '0.01']));

  it('is the identity for a multiplier of exactly 1', () => {
    const scaled = scaleMarginalPd(base, '1');
    expect(scaled.map((p) => p.marginalPd.toString())).toEqual(
      base.map((p) => p.marginalPd.toString()),
    );
  });

  it('doubles the hazard, not the marginal, so survival still compounds', () => {
    const scaled = scaleMarginalPd(base, '2');
    expect(scaled.map((p) => p.conditionalPd.toString())).toEqual(['0.02', '0.02', '0.02']);
    expect(scaled.map((p) => p.marginalPd.toString())).toEqual(['0.02', '0.0196', '0.019208']);
  });

  it('caps the conditional PD at 1 so a severe scenario cannot exceed 100% cumulative', () => {
    const stressed = toMarginalPd(structure('CONDITIONAL', ['0.5', '0.5', '0.5']));
    expect(stressed[2].cumulativePd.toString()).toEqual('0.875');
    const scaled = scaleMarginalPd(stressed, '10');
    expect(scaled.map((p) => p.conditionalPd.toString())).toEqual(['1', '1', '1']);
    expect(scaled[2].cumulativePd.toString()).toEqual('1');
    for (const point of scaled) {
      expect(point.cumulativePd.lessThanOrEqualTo(one())).toBe(true);
    }
  });

  it('rejects a non-positive or non-finite multiplier', () => {
    expect(codeOf(() => scaleMarginalPd(base, '0'))).toEqual('SCENARIO_FACTOR_INVALID');
    expect(codeOf(() => scaleMarginalPd(base, '-1.5'))).toEqual('SCENARIO_FACTOR_INVALID');
    expect(codeOf(() => scaleMarginalPd(base, Number.NaN))).toEqual('SCENARIO_FACTOR_INVALID');
  });
});

describe('cumulativePdOver', () => {
  const points = toMarginalPd(structure('CONDITIONAL', ['0.01', '0.01', '0.01', '0.01']));

  it('sums the whole horizon by default', () => {
    // 0.01 + 0.0099 + 0.009801 + 0.00970299
    expect(cumulativePdOver(points).toString()).toEqual('0.03940399');
  });

  it('sums a 12-month style window when asked for a sub-range', () => {
    expect(cumulativePdOver(points, 1, 2).toString()).toEqual('0.0199');
    expect(cumulativePdOver(points, 3, 4).toString()).toEqual('0.01950399');
  });

  it('returns zero for an empty window', () => {
    expect(cumulativePdOver([], 1, 12).toString()).toEqual(zero().toString());
  });
});

describe('deriveTermStructureFromAnchors — flat-hazard interpolation', () => {
  it('reproduces both anchors over a 24-month term', () => {
    const points = deriveTermStructureFromAnchors({
      twelveMonthPd: '0.06',
      lifetimePd: '0.15',
      remainingMonths: 24,
    });

    expect(points).toHaveLength(24);
    expect(points.map((p) => p.period)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));

    const cumulativeAt = (end: number): string => cumulativePdOver(points, 1, end).toFixed(10);
    expect(cumulativeAt(12)).toEqual(dec('0.06').toFixed(10));
    expect(cumulativeAt(24)).toEqual(dec('0.15').toFixed(10));

    for (const point of points) {
      expect(point.marginalPd.greaterThanOrEqualTo(zero())).toBe(true);
      expect(point.cumulativePd.lessThanOrEqualTo(one())).toBe(true);
    }
    // Inside each block the hazard is flat, so marginals decline as survival
    // decays. Across the boundary the tail hazard is deliberately higher than
    // the near hazard (lifetime PD > 12-month PD), so marginals step up.
    const declinesWithin = (from: number, to: number): void => {
      for (let i = from + 1; i <= to; i += 1) {
        expect(points[i - 1].marginalPd.lessThanOrEqualTo(points[i - 2].marginalPd)).toBe(true);
      }
    };
    declinesWithin(2, 12);
    declinesWithin(14, 24);
    expect(points[12].marginalPd.greaterThan(points[11].marginalPd)).toBe(true);
  });

  it('uses the lifetime PD as the only anchor when the term is 12 months or less', () => {
    const points = deriveTermStructureFromAnchors({
      twelveMonthPd: '0.02',
      lifetimePd: '0.08',
      remainingMonths: 6,
    });
    expect(points).toHaveLength(6);
    expect(cumulativePdOver(points).toFixed(10)).toEqual(dec('0.08').toFixed(10));
  });

  it('rejects a lifetime PD below the 12-month PD over a longer term', () => {
    expect(
      codeOf(() =>
        deriveTermStructureFromAnchors({
          twelveMonthPd: '0.20',
          lifetimePd: '0.10',
          remainingMonths: 36,
        }),
      ),
    ).toEqual('PD_TERM_STRUCTURE_INCONSISTENT');
  });

  it('rejects a non-positive remaining term', () => {
    expect(
      codeOf(() =>
        deriveTermStructureFromAnchors({ twelveMonthPd: '0.02', lifetimePd: '0.05', remainingMonths: 0 }),
      ),
    ).toEqual('INVALID_HORIZON');
  });

  it('clamps anchors into the configured PD band before interpolating', () => {
    const points = deriveTermStructureFromAnchors({
      twelveMonthPd: '0',
      lifetimePd: '0',
      remainingMonths: 12,
      pdFloor: '0.0001',
      pdCeiling: '0.9999',
    });
    expect(points).toHaveLength(12);
    expect(cumulativePdOver(points).greaterThan(zero())).toBe(true);
  });
});
