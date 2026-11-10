import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeEMA, computeBB, computeRSI, computeIndicator, INDICATORS, validateParams } from '../../src/indicators.js';
import { generateCandles } from '../../src/generator.js';
import { parseKline } from '../../src/live.js';
import { refEMA, refBB, refRSI, expectSeriesClose } from './helpers.js';
import { SOURCES } from '../../src/sma.js';

const candles = generateCandles({ seed: 42, count: 300 });
const candle = (time, close, extra = {}) => ({ time, open: close, high: close, low: close, close, volume: 100, ...extra });
const closes = (xs) => xs.map((x, i) => candle(i + 1, x));
const values = (pts) => pts.map((p) => p.value);

describe('EMA', () => {
  for (const source of SOURCES) {
    for (const period of [1, 2, 5, 14, 20, 50, 299, 300]) {
      it(`${source}, period ${period} matches the reference`, () => {
        expectSeriesClose(computeEMA(candles, period, source), refEMA(candles, period, source));
      });
    }
  }
  it('hand-calculated: [1..5], period 3', () => {
    // seed = (1+2+3)/3 = 2 at bar 3, alpha = 0.5 -> 3, 4
    expect(computeEMA(closes([1, 2, 3, 4, 5]), 3)).toEqual([{ time: 3, value: 2 }, { time: 4, value: 3 }, { time: 5, value: 4 }]);
  });
  it('period 1 follows the price exactly', () => {
    expect(values(computeEMA(candles, 1, 'close'))).toEqual(candles.map((c) => c.close));
  });
  it('first point appears at bar index period-1; period longer than data gives nothing', () => {
    expect(computeEMA(candles, 10)[0].time).toBe(candles[9].time);
    expect(computeEMA(candles, 301)).toEqual([]);
    expect(computeEMA([], 5)).toEqual([]);
  });
  it('a constant price gives a constant EMA', () => {
    expect(values(computeEMA(closes(Array(30).fill(7.5)), 10)).every((v) => v === 7.5)).toBe(true);
  });
  it('reacts faster than SMA to a jump', () => {
    const data = closes([...Array(20).fill(100), ...Array(5).fill(200)]);
    const ema = computeEMA(data, 10).at(-1).value;
    expect(ema).toBeGreaterThan(100 + 0.5 * 100 * (1 - Math.pow(1 - 2 / 11, 5)) - 1); // moved a lot
    expect(ema).toBeLessThan(200);
  });
  it('a bad value breaks the chain; it starts again after `period` good values', () => {
    const data = closes(Array.from({ length: 12 }, (_, i) => i + 1));
    data[5].close = NaN; // bar 6
    const times = computeEMA(data, 3).map((p) => p.time);
    expect(times).toEqual([3, 4, 5, /* gap at 6..8 */ 9, 10, 11, 12]);
  });
  it.each([NaN, null, undefined, Infinity, '5'])('bad value %s is skipped without Infinity or NaN in the output', (bad) => {
    const data = closes(Array.from({ length: 30 }, (_, i) => 100 + i));
    data[15].close = bad;
    expect(computeEMA(data, 5).every((p) => Number.isFinite(p.value))).toBe(true);
  });
  it('negative prices work', () => {
    const neg = candles.map((c) => ({ ...c, close: c.close - 500 }));
    expectSeriesClose(computeEMA(neg, 10), refEMA(neg, 10, 'close'));
  });
  it('overflow gives a gap, not Infinity', () => {
    expect(computeEMA(closes([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]), 3)).toEqual([]);
  });
});

describe('Bollinger Bands', () => {
  for (const source of SOURCES) {
    for (const [period, mult] of [[1, 2], [2, 2], [5, 1], [20, 2], [20, 3.5], [50, 2], [300, 2]]) {
      it(`${source}, period ${period}, mult ${mult} matches the reference`, () => {
        const got = computeBB(candles, period, mult, source);
        const want = refBB(candles, period, mult, source);
        for (const line of ['upper', 'basis', 'lower']) expectSeriesClose(got[line], want[line]);
      });
    }
  }
  it('hand-calculated: [1,2,3], period 3, mult 2', () => {
    const sd = Math.sqrt(2 / 3);
    const r = computeBB(closes([1, 2, 3]), 3, 2);
    expect(r.basis).toEqual([{ time: 3, value: 2 }]);
    expect(r.upper[0].value).toBeCloseTo(2 + 2 * sd, 12);
    expect(r.lower[0].value).toBeCloseTo(2 - 2 * sd, 12);
  });
  it('mult 0 and period 1 collapse the bands onto the basis', () => {
    const a = computeBB(candles, 20, 0);
    expect(a.upper).toEqual(a.basis);
    expect(a.lower).toEqual(a.basis);
    const b = computeBB(candles, 1, 2);
    expect(b.upper).toEqual(b.basis);
  });
  it('bands are symmetric around the basis and ordered', () => {
    const r = computeBB(candles, 20, 2);
    r.basis.forEach((p, i) => {
      expect(r.upper[i].value).toBeGreaterThanOrEqual(p.value);
      expect(r.lower[i].value).toBeLessThanOrEqual(p.value);
      expect(r.upper[i].value + r.lower[i].value).toBeCloseTo(2 * p.value, 6);
    });
  });
  it('a constant price gives zero width', () => {
    const r = computeBB(closes(Array(25).fill(50)), 20, 2);
    expect(r.upper.every((p) => p.value === 50)).toBe(true);
  });
  it('the basis equals the SMA times', () => {
    expect(computeBB(candles, 20, 2).basis.at(-1).time).toBe(candles.at(-1).time);
    expect(computeBB(candles, 20, 2).basis).toHaveLength(281);
  });
  it('period longer than data, empty data', () => {
    expect(computeBB(candles, 301, 2).basis).toEqual([]);
    expect(computeBB([], 5, 2).upper).toEqual([]);
  });
  it('a bad value leaves a gap only in windows that contain it', () => {
    const data = closes(Array.from({ length: 10 }, (_, i) => 10 + i));
    data[5].close = NaN;
    // the bad value is bar 6: windows ending at bars 6, 7 and 8 contain it
    expect(computeBB(data, 3, 2).basis.map((p) => p.time)).toEqual([3, 4, 5, 9, 10]);
  });
  it('overflow gives a gap, not Infinity', () => {
    const r = computeBB(closes([Number.MAX_VALUE, Number.MAX_VALUE]), 2, 2);
    expect(r.upper).toEqual([]);
  });
});

describe('RSI', () => {
  for (const source of SOURCES) {
    for (const period of [1, 2, 5, 14, 20, 50, 299]) {
      it(`${source}, period ${period} matches the reference`, () => {
        expectSeriesClose(computeRSI(candles, period, source), refRSI(candles, period, source));
      });
    }
  }
  it('hand-calculated: [10,12,11,13], period 2', () => {
    // changes +2 -1 +2: avgGain 1, avgLoss 0.5 -> RS 2 -> 66.667; then avgGain 1.5, avgLoss 0.25 -> RS 6 -> 85.714
    const r = computeRSI(closes([10, 12, 11, 13]), 2);
    expect(r.map((p) => p.time)).toEqual([3, 4]);
    expect(r[0].value).toBeCloseTo(200 / 3, 10);
    expect(r[1].value).toBeCloseTo(600 / 7, 10);
  });
  it('only gains -> 100, only losses -> 0, flat -> 100 (TradingView rule)', () => {
    expect(values(computeRSI(closes([1, 2, 3, 4, 5, 6]), 3))).toEqual([100, 100, 100]);
    expect(values(computeRSI(closes([6, 5, 4, 3, 2, 1]), 3))).toEqual([0, 0, 0]);
    expect(values(computeRSI(closes([5, 5, 5, 5, 5]), 3))).toEqual([100, 100]);
  });
  it('period 1 jumps between 100 and 0 with the direction of the last change', () => {
    expect(values(computeRSI(closes([1, 3, 2, 2, 5]), 1))).toEqual([100, 0, 100, 100]);
  });
  it('always stays within 0..100 on many random series', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const data = generateCandles({ seed, count: 120, noise: 3 + seed });
      for (const p of computeRSI(data, 14)) {
        expect(p.value).toBeGreaterThanOrEqual(0);
        expect(p.value).toBeLessThanOrEqual(100);
      }
    }
  });
  it('first value appears at bar index `period` (needs `period` changes)', () => {
    expect(computeRSI(candles, 14)[0].time).toBe(candles[14].time);
    expect(computeRSI(candles, 300)).toEqual([]);
    expect(computeRSI(candles, 299)).toHaveLength(1);
    expect(computeRSI([], 14)).toEqual([]);
  });
  it('a bad value breaks the chain; it needs period+1 good values to start again', () => {
    const data = closes(Array.from({ length: 14 }, (_, i) => 10 + (i % 3)));
    data[6].close = NaN; // bar 7
    expect(computeRSI(data, 3).map((p) => p.time)).toEqual([4, 5, 6, /* gap */ 11, 12, 13, 14]);
  });
  it('negative prices and huge prices work', () => {
    const neg = candles.map((c) => ({ ...c, close: c.close - 500 }));
    expectSeriesClose(computeRSI(neg, 14), refRSI(neg, 14, 'close'));
    const big = candles.map((c) => ({ ...c, close: c.close * 1e12 }));
    expectSeriesClose(computeRSI(big, 14), refRSI(big, 14, 'close'));
  });
  it('overflow of a price change gives a gap, not NaN', () => {
    const r = computeRSI(closes([-Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]), 2);
    expect(r.every((p) => Number.isFinite(p.value))).toBe(true);
  });
});

describe('parameters and dispatch', () => {
  it.each([0, -1, 1.5, NaN, Infinity])('period %s is rejected by every indicator', (period) => {
    expect(() => computeEMA(candles, period)).toThrow(RangeError);
    expect(() => computeBB(candles, period, 2)).toThrow(RangeError);
    expect(() => computeRSI(candles, period)).toThrow(RangeError);
    expect(() => validateParams('sma', { period })).toThrow(RangeError);
  });
  it.each([-1, NaN, Infinity, '2', null])('multiplier %s is rejected', (mult) => {
    expect(() => computeBB(candles, 20, mult)).toThrow(RangeError);
    expect(() => validateParams('bb', { period: 20, mult })).toThrow(RangeError);
  });
  it('the multiplier is not checked for other indicators', () => {
    expect(() => validateParams('ema', { period: 20, mult: NaN })).not.toThrow();
  });
  it('unknown source and unknown indicator', () => {
    expect(() => computeEMA(candles, 5, 'vwap')).toThrow(/Unknown source/);
    expect(() => computeBB(candles, 5, 2, 'vwap')).toThrow(/Unknown source/);
    expect(() => computeRSI(candles, 5, 'vwap')).toThrow(/Unknown source/);
    expect(() => computeIndicator('macd', candles, { period: 5 })).toThrow(/Unknown indicator/);
  });
  it('computeIndicator returns the lines each indicator declares', () => {
    for (const [kind, def] of Object.entries(INDICATORS)) {
      const out = computeIndicator(kind, candles, { period: 14, mult: 2 }, 'close');
      expect(Object.keys(out).sort()).toEqual(def.lines.map((l) => l.key).sort());
      expect(def.lines.filter((l) => l.primary)).toHaveLength(1);
    }
  });
  it('defaults', () => {
    expect(INDICATORS.sma.defaults).toEqual({ period: 20 });
    expect(INDICATORS.ema.defaults).toEqual({ period: 20 });
    expect(INDICATORS.bb.defaults).toEqual({ period: 20, mult: 2 });
    expect(INDICATORS.rsi.defaults).toEqual({ period: 14 });
    expect(INDICATORS.rsi.pane).toBe(1);
  });
});

// Calculated outside JavaScript (Python, Decimal) from 50 real BTCUSDT 1m bars, 2026-11-10 15:28..16:17 UTC.
describe('golden values on real BTCUSDT data', () => {
  const real = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url))).map(parseKline);
  const last = (pts, back = 0) => pts[pts.length - 1 - back].value;

  it('EMA 20 / 5 / first point', () => {
    expect(last(computeEMA(real, 20))).toBeCloseTo(73346.247551, 5);
    expect(last(computeEMA(real, 5))).toBeCloseTo(73429.147754, 5);
    expect(computeEMA(real, 20)[0].value).toBeCloseTo(73521.755, 5);
  });
  it('EMA 20 on the last closed bar (16:16 UTC)', () => {
    expect(last(computeEMA(real, 20), 1)).toBeCloseTo(73331.326241, 5);
  });
  it('Bollinger (20, 2) on the last bar and on 16:16 UTC', () => {
    const r = computeBB(real, 20, 2);
    expect(last(r.upper)).toBeCloseTo(73476.760393, 5);
    expect(last(r.basis)).toBeCloseTo(73310.6635, 5);
    expect(last(r.lower)).toBeCloseTo(73144.566607, 5);
    expect(last(r.upper, 1)).toBeCloseTo(73445.283309, 5);
    expect(last(r.basis, 1)).toBeCloseTo(73298.764, 5);
    expect(last(r.lower, 1)).toBeCloseTo(73152.244691, 5);
  });
  it('Bollinger (10, 3)', () => {
    const r = computeBB(real, 10, 3);
    expect(last(r.upper)).toBeCloseTo(73589.618664, 5);
    expect(last(r.basis)).toBeCloseTo(73361.726, 5);
    expect(last(r.lower)).toBeCloseTo(73133.833336, 5);
  });
  it('RSI 14 / 5 / first point / 16:16 UTC', () => {
    expect(last(computeRSI(real, 14))).toBeCloseTo(57.935321, 5);
    expect(last(computeRSI(real, 14), 1)).toBeCloseTo(57.717625, 5);
    expect(computeRSI(real, 14)[0].value).toBeCloseTo(5.056512, 5);
    expect(last(computeRSI(real, 5))).toBeCloseTo(77.714201, 5);
  });
});

describe('speed', () => {
  const long = generateCandles({ seed: 42, count: 2000 });
  it.each([
    ['EMA', () => computeEMA(long, 200, 'ohlc4')],
    ['BB', () => computeBB(long, 200, 2, 'ohlc4')],
    ['RSI', () => computeRSI(long, 200, 'ohlc4')],
  ])('%s over 2000 bars is fast', (_, run) => {
    const t = performance.now();
    run();
    expect(performance.now() - t).toBeLessThan(300);
  });
});
