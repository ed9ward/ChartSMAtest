import { describe, it, expect } from 'vitest';
import { compareSeries, refBB } from '../../checks/reference.js';

describe('compareSeries', () => {
  it('uses a relative tolerance for values below one', () => {
    expect(() => compareSeries(
      [{ time: 1, value: 1.01e-8 }, { time: 2, value: 2e-8 }],
      [{ time: 1, value: 1e-8 }, { time: 2, value: 2e-8 }],
    )).toThrow(/value mismatch/);
  });

  it('still allows ordinary floating-point noise at small magnitudes', () => {
    expect(() => compareSeries(
      [{ time: 1, value: 1.0000005e-8 }, { time: 2, value: 2e-8 }],
      [{ time: 1, value: 1e-8 }, { time: 2, value: 2e-8 }],
    )).not.toThrow();
  });

  it('uses the series scale near zero without a one-unit absolute floor', () => {
    expect(() => compareSeries(
      [{ time: 1, value: 100 }, { time: 2, value: 2e-7 }],
      [{ time: 1, value: 100 }, { time: 2, value: 0 }],
    )).toThrow(/value mismatch/);
    expect(() => compareSeries(
      [{ time: 1, value: 100 }, { time: 2, value: 5e-8 }],
      [{ time: 1, value: 100 }, { time: 2, value: 0 }],
    )).not.toThrow();
  });

  it('still checks series length and timestamps', () => {
    expect(() => compareSeries([], [{ time: 1, value: 1 }])).toThrow(/length mismatch/);
    expect(() => compareSeries(
      [{ time: 2, value: 1 }],
      [{ time: 1, value: 1 }],
    )).toThrow(/time mismatch/);
  });
});

describe('independent Bollinger reference', () => {
  it('retains small variance around a very large price level', () => {
    const prices = [1e12, 1e12 + 0.001, 1e12 - 0.001, 1e12 + 0.002];
    const candles = prices.map((close, i) => ({
      time: i + 1, open: close, high: close, low: close, close, volume: 1,
    }));
    const bands = refBB(candles, 4, 2, 'close');
    expect(bands.upper[0].value).toBeGreaterThan(bands.basis[0].value);
    expect(bands.lower[0].value).toBeLessThan(bands.basis[0].value);
  });
});
