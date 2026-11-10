import { describe, it, expect } from 'vitest';
import { sanitizeCandles, MAX_ABS_PRICE } from '../../src/sanitize.js';
import { generateCandles } from '../../src/generator.js';
import { SCENARIOS } from '../../src/scenarios.js';

const good = generateCandles({ seed: 1, count: 20 });

describe('sanitizeCandles', () => {
  it('passes clean data through unchanged', () => {
    const r = sanitizeCandles(good);
    expect(r.candles).toEqual(good);
    expect(r.issues).toEqual([]);
  });
  it('keeps negative prices', () => {
    const r = sanitizeCandles(SCENARIOS.negative());
    expect(r.candles).toHaveLength(60);
    expect(r.candles.every((c) => c.low < 0)).toBe(true);
    expect(r.issues).toEqual([]);
  });
  it('drops NaN / null fields and reports it', () => {
    const r = sanitizeCandles(SCENARIOS.nan());
    expect(r.candles).toHaveLength(58);
    expect(r.issues.join()).toMatch(/dropped 2 invalid/);
  });
  it('drops values beyond the allowed range', () => {
    const r = sanitizeCandles(SCENARIOS.overflow());
    expect(r.candles).toHaveLength(59);
    expect(r.issues.join()).toMatch(/out-of-range/);
    expect(MAX_ABS_PRICE).toBe(1e12);
  });
  it('merges duplicate timestamps (last wins)', () => {
    const dup = [...good, { ...good[3], close: 999 }];
    const r = sanitizeCandles(dup);
    expect(r.candles).toHaveLength(20);
    expect(r.candles[3].close).toBe(999);
    expect(r.issues.join()).toMatch(/duplicate/);
  });
  it('sorts unordered data', () => {
    const r = sanitizeCandles(SCENARIOS.unordered());
    expect(r.candles.map((c) => c.time)).toEqual([...r.candles.map((c) => c.time)].sort((a, b) => a - b));
    expect(r.issues.join()).toMatch(/unordered/);
  });
  it.each([[[]], [null], [undefined], ['x'], [{}]])('handles %j without throwing', (input) => {
    const r = sanitizeCandles(input);
    expect(r.candles).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it('drops candles with garbage entries inside the array', () => {
    const r = sanitizeCandles([good[0], null, 5, { time: 'a' }, good[1]]);
    expect(r.candles).toHaveLength(2);
  });
});
