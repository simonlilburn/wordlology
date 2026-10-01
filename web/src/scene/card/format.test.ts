import { describe, expect, it } from 'vitest';
import { fmtCount, fmtMean, fmtPercent, fmtQuantile, progressText, roundSig, rowLongName, rowName } from './format';

describe('card number formatting', () => {
  it('drops one digit and adds ~ while provisional', () => {
    expect(fmtCount(1234)).toBe('1,234');
    expect(fmtCount(1234, true)).toBe('~1,230');
    expect(fmtCount(7, true)).toBe('~7');
    expect(fmtCount(0, true)).toBe('~0');
    expect(fmtPercent(0.3421)).toBe('34.2%');
    expect(fmtPercent(0.3421, true)).toBe('~34%');
    expect(fmtPercent(0.0001)).toBe('<0.1%');
    expect(fmtPercent(0.001, true)).toBe('<1%');
    expect(fmtMean(3.6213)).toBe('3.62');
    expect(fmtMean(3.6213, 0.0123)).toBe('3.62 ± 0.01');
    expect(fmtMean(3.6213, 0.0031)).toBe('3.62 ± 0.003');
    expect(fmtMean(3.6213, 0.01, true)).toBe('~3.6');
    expect(fmtMean(NaN)).toBe('–');
  });

  it('rounds to significant digits', () => {
    expect(roundSig(12345, 2)).toBe(12000);
    expect(roundSig(0.012345, 3)).toBeCloseTo(0.0123, 10);
    expect(roundSig(0, 2)).toBe(0);
  });

  it('names rows and quantiles', () => {
    expect(rowName(0, 6)).toBe('1');
    expect(rowName(6, 6)).toBe('Out');
    expect(rowLongName(2, 6)).toBe('Guess 3');
    expect(fmtQuantile(5, 6)).toBe('5');
    expect(fmtQuantile(7, 6)).toBe('X');
    expect(fmtQuantile(4, 6, true)).toBe('~4');
  });

  it('writes the progress line', () => {
    expect(progressText({ deterministic: false, nTargetsDone: 640, nTargets: 2315, nGames: 640, expectedGames: 46300 })).toBe(
      'estimate · 640 / 2,315 targets',
    );
    expect(progressText({ deterministic: false, nTargetsDone: 2315, nTargets: 2315, nGames: 5000, expectedGames: 46300 })).toBe(
      'estimate · 5,000 / 46,300 games',
    );
    expect(progressText({ deterministic: true, nTargetsDone: 100, nTargets: 2315, nGames: 100, expectedGames: 2315, settledDepth: 3 })).toBe(
      'resolving · 100 / 2,315 targets · settled to guess 3',
    );
  });
});
