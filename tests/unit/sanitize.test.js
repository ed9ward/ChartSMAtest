import { describe, it, expect } from 'vitest';
import { sanitizeCandles, validateCandle, MAX_ABS_PRICE } from '../../src/sanitize.js';
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
    const dup = [...good, { ...good[3], high: 999, close: 999 }];
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

const candle = (over = {}) => ({ time: 1000, open: 100, high: 110, low: 90, close: 105, volume: 5, ...over });

describe('validateCandle', () => {
  it('accepts a normal candle', () => {
    expect(validateCandle(candle())).toBeNull();
  });
  it.each([
    ['a flat candle (all prices equal)', { open: 100, high: 100, low: 100, close: 100 }],
    ['zero volume', { volume: 0 }],
    ['all prices zero', { open: 0, high: 0, low: 0, close: 0 }],
    ['high equal to the open', { open: 110 }],
    ['high equal to the close', { close: 110 }],
    ['low equal to the open', { open: 90 }],
    ['low equal to the close', { close: 90 }],
    ['a doji (open equals close)', { open: 100, close: 100 }],
    ['a down candle', { open: 108, close: 92 }],
    ['negative prices, consistent', { open: -100, high: -90, low: -110, close: -95 }],
    ['prices around zero', { open: -1, high: 2, low: -3, close: 1 }],
    ['the largest allowed price', { open: MAX_ABS_PRICE, high: MAX_ABS_PRICE, low: MAX_ABS_PRICE - 1, close: MAX_ABS_PRICE }],
    ['tiny prices', { open: 1e-9, high: 2e-9, low: 5e-10, close: 1.5e-9 }],
    ['fractional volume', { volume: 0.00001 }],
  ])('accepts %s', (_, over) => {
    expect(validateCandle(candle(over))).toBeNull();
  });

  it.each([
    ['high below the close', { high: 100, close: 105 }],
    ['high below the open', { high: 95, open: 100 }],
    ['high below the low', { high: 90, low: 95, open: 90, close: 90 }],
    ['low above the close', { low: 100, close: 95, open: 100, high: 110 }],
    ['low above the open', { low: 101, open: 100, close: 105 }],
    ['high and low swapped', { high: 90, low: 110 }],
    ['negative volume', { volume: -5 }],
    ['tiny negative volume', { volume: -1e-9 }],
    ['negative prices, high below low', { open: -100, high: -110, low: -90, close: -100 }],
    ['negative prices, high below close', { open: -100, high: -101, low: -110, close: -95 }],
    ['a high just below the close', { close: 110.0001 }],
    ['a low just above the open', { open: 89.9999, low: 90.0001, close: 100 }],
  ])('rejects %s as inconsistent', (_, over) => {
    expect(validateCandle(candle(over))).toBe('inconsistent');
  });

  it.each([
    ['NaN price', { open: NaN }], ['Infinity', { high: Infinity }], ['-Infinity', { low: -Infinity }], ['null price', { close: null }],
    ['string price', { open: '100' }], ['undefined price', { high: undefined }], ['NaN volume', { volume: NaN }],
    ['missing volume', { volume: undefined }], ['string volume', { volume: '5' }], ['NaN time', { time: NaN }], ['missing time', { time: undefined }],
  ])('rejects %s as invalid', (_, over) => {
    expect(validateCandle(candle(over))).toBe('invalid');
  });

  it.each([[null], [undefined], [0], ['x'], [[]], [42]])('rejects %j as invalid', (value) => {
    expect(validateCandle(value)).toBe('invalid');
  });

  it('an absurd price is out of range, and "not a number" wins over "out of range"', () => {
    expect(validateCandle(candle({ high: MAX_ABS_PRICE * 10 }))).toBe('range');
    expect(validateCandle(candle({ low: -MAX_ABS_PRICE * 10 }))).toBe('range');
    expect(validateCandle(candle({ high: 1e15, open: NaN }))).toBe('invalid');
  });

  it('out of range wins over inconsistent', () => {
    expect(validateCandle(candle({ high: 1e15, low: 2e15 }))).toBe('range');
  });
});

describe('sanitizeCandles drops inconsistent candles', () => {
  it('the scenario with four impossible candles keeps 56 and says why', () => {
    const r = sanitizeCandles(SCENARIOS.inconsistent());
    expect(r.candles).toHaveLength(56);
    expect(r.issues).toEqual(['dropped 4 inconsistent candle(s) (impossible high/low or negative volume)']);
  });
  it('flat and zero-volume candles survive', () => {
    const r = sanitizeCandles(SCENARIOS.inconsistent());
    const times = SCENARIOS.normal().map((c) => c.time);
    expect(r.candles.some((c) => c.time === times[50] && c.volume === 0)).toBe(true);
    expect(r.candles.some((c) => c.time === times[55] && c.open === 100 && c.high === 100)).toBe(true);
  });
  it('the dropped ones are exactly the broken ones', () => {
    const kept = new Set(sanitizeCandles(SCENARIOS.inconsistent()).candles.map((c) => c.time));
    const times = SCENARIOS.normal().map((c) => c.time);
    for (const i of [10, 20, 30, 40]) expect(kept.has(times[i])).toBe(false);
    for (const i of [9, 11, 19, 21, 29, 31, 39, 41, 50, 55]) expect(kept.has(times[i])).toBe(true);
  });
  it('reports invalid, out-of-range and inconsistent separately', () => {
    const mixed = [good[0], { ...good[1], open: NaN }, { ...good[2], high: 1e15 }, { ...good[3], volume: -1 }, { ...good[4], high: 0, low: 1 }];
    const r = sanitizeCandles(mixed);
    expect(r.candles).toHaveLength(1);
    expect(r.issues).toEqual(['dropped 1 invalid candle(s)', 'dropped 1 out-of-range candle(s)', 'dropped 2 inconsistent candle(s) (impossible high/low or negative volume)']);
  });
  it('a broken duplicate does not replace a good candle with the same time', () => {
    const r = sanitizeCandles([good[3], { ...good[3], high: 0, low: 1 }]);
    expect(r.candles).toEqual([good[3]]);
    expect(r.issues.join()).not.toMatch(/duplicate/);
  });
  it('negative prices are still fine when consistent', () => {
    const neg = good.map((c) => ({ ...c, open: c.open - 500, high: c.high - 500, low: c.low - 500, close: c.close - 500 }));
    expect(sanitizeCandles(neg).candles).toHaveLength(good.length);
  });
});

describe('everything the app itself produces passes the same rule', () => {
  it('generated candles, partial candles of the demo feed, and the demo data sets', async () => {
    const { generateCandles, partialCandle } = await import('../../src/generator.js');
    for (const seed of [1, 7, 42, 99]) {
      for (const c of generateCandles({ seed, count: 400, noise: 5 })) {
        expect(validateCandle(c), JSON.stringify(c)).toBeNull();
        for (let k = 1; k <= 5; k++) expect(validateCandle(partialCandle(c, k, 5)), `${JSON.stringify(c)} k=${k}`).toBeNull();
      }
    }
    for (const name of ['normal', 'long', 'negative', 'huge']) expect(sanitizeCandles(SCENARIOS[name]()).issues).toEqual([]);
  });
});
