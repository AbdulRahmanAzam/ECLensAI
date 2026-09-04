/**
 * required_tests[5] — drawn and undrawn EAD using the credit conversion factor.
 *
 * EAD(period) = drawn balance(period) + CCF x undrawn commitment(period).
 */
import { describe, expect, it } from 'vitest';
import { buildEadSchedule, periodEad, validateCreditConversionFactor } from '../src/index';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
};

describe('periodEad — the commitment-conversion identity', () => {
  it('converts half of a 500k undrawn commitment at a 50% CCF', () => {
    // 1,000,000 + 0.5 x 500,000 = 1,250,000
    expect(periodEad('1000000', '500000', '0.5').toString()).toEqual('1250000');
  });

  it('ignores the undrawn commitment entirely at a zero CCF', () => {
    expect(periodEad('1000000', '500000', '0').toString()).toEqual('1000000');
  });

  it('adds the whole commitment at a 100% CCF', () => {
    expect(periodEad('1000000', '500000', '1').toString()).toEqual('1500000');
  });

  it('keeps exact decimal arithmetic where binary floats would not', () => {
    // 0.1 + 0.2 x 0.3 = 0.16 exactly; in IEEE-754 this is 0.16000000000000003.
    expect(periodEad('0.1', '0.3', '0.2').toString()).toEqual('0.16');
  });

  it('rejects a negative drawn balance or undrawn commitment', () => {
    expect(codeOf(() => periodEad('-1', '0', '0.5'))).toEqual('EAD_NEGATIVE');
    expect(codeOf(() => periodEad('1', '-0.01', '0.5'))).toEqual('EAD_NEGATIVE');
  });
});

describe('validateCreditConversionFactor', () => {
  it('accepts the closed interval [0, 1]', () => {
    expect(validateCreditConversionFactor('0').toString()).toEqual('0');
    expect(validateCreditConversionFactor('1').toString()).toEqual('1');
    expect(validateCreditConversionFactor('0.75').toString()).toEqual('0.75');
  });

  it('rejects anything outside it', () => {
    expect(codeOf(() => validateCreditConversionFactor('1.5'))).toEqual('CCF_OUT_OF_RANGE');
    expect(codeOf(() => validateCreditConversionFactor('-0.1'))).toEqual('CCF_OUT_OF_RANGE');
  });
});

describe('buildEadSchedule — contractual schedules win', () => {
  const schedule = buildEadSchedule({
    periods: 4,
    grossCarryingAmount: '1000000',
    undrawnCommitment: '400000',
    creditConversionFactor: '0.5',
    contractualSchedule: [
      { period: 1, drawnBalance: '900000', undrawnCommitment: '400000' },
      { period: 2, drawnBalance: '800000', undrawnCommitment: '400000' },
    ],
  });

  it('uses the supplied period balances and labels their provenance', () => {
    expect(schedule.kind).toEqual('CONTRACTUAL_SCHEDULE');
    expect(schedule.label).toEqual(
      'Contractual amortization schedule supplied by the source system',
    );
    // 900,000 + 0.5 x 400,000 = 1,100,000 and 800,000 + 200,000 = 1,000,000
    expect(schedule.points[0].ead.toString()).toEqual('1100000');
    expect(schedule.points[1].ead.toString()).toEqual('1000000');
  });

  it('holds the final balance flat past the end of the schedule and says so', () => {
    expect(schedule.extendedFlatBeyondSchedule).toBe(true);
    expect(schedule.points).toHaveLength(4);
    expect(schedule.points[2].drawnBalance.toString()).toEqual('800000');
    expect(schedule.points[3].ead.toString()).toEqual('1000000');
  });

  it('does not flag an extension when the schedule covers the horizon', () => {
    const exact = buildEadSchedule({
      periods: 2,
      grossCarryingAmount: '900000',
      undrawnCommitment: '0',
      creditConversionFactor: '0',
      contractualSchedule: [
        { period: 1, drawnBalance: '900000', undrawnCommitment: '0' },
        { period: 2, drawnBalance: '0', undrawnCommitment: '0' },
      ],
    });
    expect(exact.extendedFlatBeyondSchedule).toBe(false);
    expect(exact.points[1].ead.toString()).toEqual('0');
  });

  it('sorts an out-of-order schedule but still rejects gaps', () => {
    const unsorted = buildEadSchedule({
      periods: 2,
      grossCarryingAmount: '200',
      undrawnCommitment: '0',
      creditConversionFactor: '0',
      contractualSchedule: [
        { period: 2, drawnBalance: '100', undrawnCommitment: '0' },
        { period: 1, drawnBalance: '200', undrawnCommitment: '0' },
      ],
    });
    expect(unsorted.points.map((p) => p.drawnBalance.toString())).toEqual(['200', '100']);

    expect(
      codeOf(() =>
        buildEadSchedule({
          periods: 2,
          grossCarryingAmount: '200',
          undrawnCommitment: '0',
          creditConversionFactor: '0',
          contractualSchedule: [
            { period: 1, drawnBalance: '200', undrawnCommitment: '0' },
            { period: 3, drawnBalance: '100', undrawnCommitment: '0' },
          ],
        }),
      ),
    ).toEqual('PD_TERM_STRUCTURE_GAPS');
  });
});

describe('buildEadSchedule — simplified profiles are labelled as assumptions', () => {
  it('holds a flat balance constant and says no schedule was supplied', () => {
    const flat = buildEadSchedule({
      periods: 3,
      grossCarryingAmount: '1000000',
      undrawnCommitment: '400000',
      creditConversionFactor: '0.5',
      simplifiedProfile: 'FLAT',
    });
    expect(flat.kind).toEqual('SIMPLIFIED_FLAT_BALANCE');
    expect(flat.label).toEqual(
      'Simplified flat balance profile — no contractual amortization schedule supplied',
    );
    expect(flat.extendedFlatBeyondSchedule).toBe(false);
    expect(flat.points.map((p) => p.ead.toString())).toEqual(['1200000', '1200000', '1200000']);
  });

  it('runs the drawn balance straight-line to zero over the horizon', () => {
    const linear = buildEadSchedule({
      periods: 4,
      grossCarryingAmount: '1200',
      undrawnCommitment: '200',
      creditConversionFactor: '0.5',
      simplifiedProfile: 'LINEAR_AMORTIZATION',
    });
    expect(linear.kind).toEqual('SIMPLIFIED_LINEAR_AMORTIZATION');
    // drawn 1200, 900, 600, 300 plus 0.5 x 200 = 100 of converted commitment
    expect(linear.points.map((p) => p.drawnBalance.toString())).toEqual([
      '1200',
      '900',
      '600',
      '300',
    ]);
    expect(linear.points.map((p) => p.ead.toString())).toEqual(['1300', '1000', '700', '400']);
    // The undrawn commitment is held flat in the simplified profiles.
    expect(linear.points.every((p) => p.undrawnCommitment.toString() === '200')).toBe(true);
  });

  it('defaults to the configured profile when none is given', () => {
    const defaulted = buildEadSchedule({
      periods: 2,
      grossCarryingAmount: '1000',
      undrawnCommitment: '0',
      creditConversionFactor: '0',
    });
    expect(defaulted.kind).toEqual('SIMPLIFIED_LINEAR_AMORTIZATION');
  });

  it('rejects a horizon with no periods', () => {
    expect(
      codeOf(() =>
        buildEadSchedule({
          periods: 0,
          grossCarryingAmount: '1000',
          undrawnCommitment: '0',
          creditConversionFactor: '0',
        }),
      ),
    ).toEqual('INVALID_HORIZON');
  });

  it('rejects a negative gross carrying amount', () => {
    expect(
      codeOf(() =>
        buildEadSchedule({
          periods: 2,
          grossCarryingAmount: '-1000',
          undrawnCommitment: '0',
          creditConversionFactor: '0',
        }),
      ),
    ).toEqual('EAD_NEGATIVE');
  });
});
