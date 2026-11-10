import { describe, it, expect } from 'vitest';
import { priceDecimals, formatFixed } from '../../src/format.js';

describe('priceDecimals', () => {
  it.each([
    [[73488.01, 73510, 73482.5], 2], [[3512.4], 2], [[148.77], 2], [[100], 2], [[1], 2], [[5e7], 2], [[1e15], 2],
    [[0.99], 4], [[0.5], 4], [[0.05], 5], [[0.0123], 5], [[0.001], 6], [[1.234e-5], 8], [[1e-8], 11], [[1e-12], 12], [[1e-30], 12],
  ])('%j -> %i decimals', (values, decimals) => {
    expect(priceDecimals(values)).toBe(decimals);
  });
  it('negative numbers are judged by their size', () => {
    expect(priceDecimals([-73488])).toBe(2);
    expect(priceDecimals([-1.2e-5, -1.3e-5])).toBe(8);
  });
  it('zeros, NaN, Infinity and nothing at all give the default', () => {
    for (const values of [[], [0], [0, 0, 0], [NaN], [Infinity, -Infinity], [NaN, 0]]) expect(priceDecimals(values)).toBe(2);
  });
  it('zeros and bad values do not count: the size is that of the real ones', () => {
    expect(priceDecimals([0, 0, 0, 1.2e-5, NaN])).toBe(8);
  });
  it('the median decides, so one outlier changes nothing', () => {
    expect(priceDecimals([1.2e-5, 1.2e-5, 1.2e-5, 1.2e-5, 9999])).toBe(8);
    expect(priceDecimals([73488, 73490, 73489, 73491, 1e-9])).toBe(2);
  });
  it('is the same for any order of the values', () => {
    expect(priceDecimals([5e-5, 1, 2e-5, 3e-5, 4e-5])).toBe(priceDecimals([1, 4e-5, 3e-5, 2e-5, 5e-5]));
  });
  it('never more than 12 and never less than 2', () => {
    for (let e = -30; e <= 30; e += 3) {
      const d = priceDecimals([10 ** e]);
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(12);
    }
  });
  it('shows at least three significant digits for any size above 1e-9', () => {
    for (let e = -9; e <= 0; e++) {
      const value = 1.234 * 10 ** e;
      expect(Math.abs(Number(value.toFixed(priceDecimals([value]))) - value) / value).toBeLessThan(5e-3);
    }
  });
});

describe('formatFixed', () => {
  it('formats with the given decimals', () => {
    expect(formatFixed(73488.014, 2)).toBe('73488.01');
    expect(formatFixed(1.234e-5, 8)).toBe('0.00001234');
    expect(formatFixed(-5, 2)).toBe('-5.00');
    expect(formatFixed(0, 8)).toBe('0.00000000');
  });
  it.each([[NaN], [Infinity], [-Infinity], [undefined], [null], ['5'], [{}]])('%j gives a dash', (value) => {
    expect(formatFixed(value, 2)).toBe('—');
  });
});
