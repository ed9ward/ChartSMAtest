import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeEMA, computeBB, computeRSI, computeIndicator, INDICATORS, validateParams, settleBars, minBars } from '../../src/indicators.js';
import { generateCandles } from '../../src/generator.js';
import { parseKline } from '../../src/live.js';
import { refEMA, refBB, refRSI, expectSeriesClose } from './helpers.js';
import { SOURCES } from '../../src/sma.js';

const candles = generateCandles({ seed: 42, count: 300 });
const candle = (time, close, extra = {}) => ({ time, open: close, high: close, low: close, close, volume: 100, ...extra });
const closes = (xs) => xs.map((x, i) => candle(i + 1, x));
const values = (pts) => pts.map((p) => p.value);

describe('numeric stability', () => {
  it('computes SMA and Bollinger Bands for very large and very small finite values', () => {
    for (const scale of [1e-200, 1e200]) {
      const data = Array.from({ length: 8 }, (_, i) => {
        const close = scale * (1 + i / 100);
        return { time: i, open: close, high: close * 1.02, low: close * 0.98, close, volume: scale };
      });
      const sma = computeIndicator('sma', data, { period: 4 }, 'close').sma;
      const bb = computeBB(data, 4, 2, 'close');
      expect(sma.length).toBe(5);
      expect(bb.basis.length).toBe(5);
      expect([...sma, ...bb.upper, ...bb.basis, ...bb.lower].every((point) => Number.isFinite(point.value))).toBe(true);
    }
  });
});

describe('EMA', () => {
  for (const start of ['first', 'sma']) {
    for (const source of SOURCES) {
      for (const period of [1, 2, 5, 14, 20, 50, 299, 300]) {
        it(`${start} start, ${source}, period ${period} matches the reference`, () => {
          expectSeriesClose(computeEMA(candles, period, source, start), refEMA(candles, period, source, start));
        });
      }
    }
  }

  describe('hand-calculated', () => {
    // alpha = 2 / (3 + 1) = 0.5
    it('first value as start: 1, 1.5, 2.25, 3.125, 4.0625', () => {
      expect(values(computeEMA(closes([1, 2, 3, 4, 5]), 3, 'close', 'first'))).toEqual([1, 1.5, 2.25, 3.125, 4.0625]);
    });
    it('SMA start: (1+2+3)/3 = 2 on bar 3, then 3, 4', () => {
      expect(computeEMA(closes([1, 2, 3, 4, 5]), 3, 'close', 'sma')).toEqual([{ time: 3, value: 2 }, { time: 4, value: 3 }, { time: 5, value: 4 }]);
    });
    it('the default is the first-value start', () => {
      expect(computeEMA(closes([1, 2, 3, 4, 5]), 3)).toEqual(computeEMA(closes([1, 2, 3, 4, 5]), 3, 'close', 'first'));
    });
  });

  describe('where the first value appears', () => {
    it('first value as start: on the first bar, for any period, even one longer than the data', () => {
      expect(computeEMA(candles, 10, 'close', 'first')[0].time).toBe(candles[0].time);
      expect(computeEMA(candles, 10, 'close', 'first')[0].value).toBe(candles[0].close);
      expect(computeEMA(candles, 1000, 'close', 'first')).toHaveLength(300);
    });
    it('SMA start: on bar index period-1; nothing if the period is longer than the data', () => {
      expect(computeEMA(candles, 10, 'close', 'sma')[0].time).toBe(candles[9].time);
      expect(computeEMA(candles, 301, 'close', 'sma')).toEqual([]);
    });
    it('empty data gives nothing', () => {
      expect(computeEMA([], 5, 'close', 'first')).toEqual([]);
      expect(computeEMA([], 5, 'close', 'sma')).toEqual([]);
    });
  });

  it.each(['first', 'sma'])('period 1 follows the price exactly (%s start)', (start) => {
    expect(values(computeEMA(candles, 1, 'close', start))).toEqual(candles.map((c) => c.close));
  });
  it.each(['first', 'sma'])('a constant price gives a constant EMA (%s start)', (start) => {
    expect(values(computeEMA(closes(Array(30).fill(7.5)), 10, 'close', start)).every((v) => v === 7.5)).toBe(true);
  });
  it('reacts to a jump but never overshoots it', () => {
    const data = closes([...Array(20).fill(100), ...Array(5).fill(200)]);
    for (const start of ['first', 'sma']) {
      const ema = computeEMA(data, 10, 'close', start).at(-1).value;
      expect(ema).toBeGreaterThan(130);
      expect(ema).toBeLessThan(200);
    }
  });

  describe('the two starts', () => {
    it('differ by a term that shrinks by (1 - alpha) on every bar, exactly', () => {
      for (const period of [5, 14, 20, 50]) {
        const a = 2 / (period + 1);
        const first = computeEMA(candles, period, 'close', 'first');
        const sma = computeEMA(candles, period, 'close', 'sma');
        const gap0 = first[period - 1].value - sma[0].value;
        expect(Math.abs(gap0)).toBeGreaterThan(0);
        sma.forEach((p, k) => expect(first[period - 1 + k].value - p.value).toBeCloseTo((1 - a) ** k * gap0, 9));
      }
    });
    it('are far apart with a long period and a short history (period 200, 300 bars)', () => {
      const first = computeEMA(candles, 200, 'close', 'first').at(-1).value;
      const sma = computeEMA(candles, 200, 'close', 'sma').at(-1).value;
      expect(Math.abs(first - sma)).toBeGreaterThan(0.1);
    });
    it('have become equal to the cent after enough bars', () => {
      const first = computeEMA(candles, 5, 'close', 'first');
      const sma = computeEMA(candles, 5, 'close', 'sma');
      expect(Math.abs(first.at(-1).value - sma.at(-1).value)).toBeLessThan(0.005);
    });
  });

  describe('bad values', () => {
    it('first value as start: the chain ends and starts again with the next good value', () => {
      const data = closes(Array.from({ length: 12 }, (_, i) => i + 1));
      data[5].close = NaN; // bar 6
      expect(computeEMA(data, 3, 'close', 'first').map((p) => p.time)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
      expect(computeEMA(data, 3, 'close', 'first').find((p) => p.time === 7).value).toBe(7); // restarted from the price
    });
    it('SMA start: after a bad value it needs `period` good values in a row again', () => {
      const data = closes(Array.from({ length: 12 }, (_, i) => i + 1));
      data[5].close = NaN; // bar 6
      expect(computeEMA(data, 3, 'close', 'sma').map((p) => p.time)).toEqual([3, 4, 5, 9, 10, 11, 12]);
    });
    it.each([NaN, null, undefined, Infinity, '5'])('bad value %s never reaches the output (both starts)', (bad) => {
      for (const start of ['first', 'sma']) {
        const data = closes(Array.from({ length: 30 }, (_, i) => 100 + i));
        data[15].close = bad;
        const out = computeEMA(data, 5, 'close', start);
        expect(out.length).toBeGreaterThan(0);
        expect(out.every((p) => Number.isFinite(p.value))).toBe(true);
      }
    });
    it('a bad first value only delays the first-value start', () => {
      const data = closes([1, 2, 3, 4]);
      data[0].close = NaN;
      expect(computeEMA(data, 3, 'close', 'first').map((p) => p.time)).toEqual([2, 3, 4]);
    });
  });

  it.each(['first', 'sma'])('negative prices work (%s start)', (start) => {
    const neg = candles.map((c) => ({ ...c, close: c.close - 500 }));
    expectSeriesClose(computeEMA(neg, 10, 'close', start), refEMA(neg, 10, 'close', start));
  });
  it.each(['first', 'sma'])('values at the edge of the number range stay finite (%s start)', (start) => {
    const out = computeEMA(closes([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]), 2, 'close', start);
    expect(out.every((p) => Number.isFinite(p.value))).toBe(true);
  });
  it('an unknown start is rejected', () => {
    for (const bad of ['SMA', 'tradingview', '', null, 1]) expect(() => computeEMA(candles, 5, 'close', bad)).toThrow(/Unknown EMA start/);
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
        expectSeriesClose(computeRSI(candles, period, source), refRSI(candles, period, source, { flat: 100 }));
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
  it('only gains -> 100, only losses -> 0 (every platform agrees); a flat price is a convention: see rsi-edge.test.js', () => {
    expect(values(computeRSI(closes([1, 2, 3, 4, 5, 6]), 3))).toEqual([100, 100, 100]);
    expect(values(computeRSI(closes([6, 5, 4, 3, 2, 1]), 3))).toEqual([0, 0, 0]);
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
    expectSeriesClose(computeRSI(neg, 14), refRSI(neg, 14, 'close', { flat: 100 }));
    const big = candles.map((c) => ({ ...c, close: c.close * 1e12 }));
    expectSeriesClose(computeRSI(big, 14), refRSI(big, 14, 'close', { flat: 100 }));
  });
  it('overflow of a price change gives a gap, not NaN', () => {
    const r = computeRSI(closes([-Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]), 2);
    expect(r.every((p) => Number.isFinite(p.value))).toBe(true);
  });
});

describe('parameters and dispatch', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('period %s is rejected by every indicator', (period) => {
    expect(() => computeEMA(candles, period)).toThrow(RangeError);
    expect(() => computeBB(candles, period, 2)).toThrow(RangeError);
    expect(() => computeRSI(candles, period)).toThrow(RangeError);
    expect(() => validateParams('sma', { period })).toThrow(RangeError);
  });
  it.each([-1, NaN, Infinity, '2', null])('multiplier %s is rejected', (mult) => {
    expect(() => computeBB(candles, 20, mult)).toThrow(RangeError);
    expect(() => validateParams('bb', { period: 20, mult })).toThrow(RangeError);
  });
  it('the EMA start is checked, and a missing one means the default', () => {
    expect(() => validateParams('ema', { period: 20, start: 'bogus' })).toThrow(RangeError);
    expect(() => validateParams('ema', { period: 20 })).not.toThrow();
    expect(() => validateParams('sma', { period: 20, start: 'bogus' })).not.toThrow();
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
    expect(INDICATORS.ema.defaults).toEqual({ period: 20, start: 'first' });
    expect(INDICATORS.bb.defaults).toEqual({ period: 20, mult: 2 });
    expect(INDICATORS.rsi.defaults).toEqual({ period: 14 });
    expect(INDICATORS.rsi.pane).toBe(1);
  });
});

// Calculated outside JavaScript (Python, Decimal) from 50 real BTCUSDT 1m bars, 2026-11-10 15:28..16:17 UTC.
describe('golden values on real BTCUSDT data', () => {
  const real = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url))).map((row) => parseKline(row));
  const last = (pts, back = 0) => pts[pts.length - 1 - back].value;

  it('EMA, first value as start: 20 / 5 / first point / 16:16 UTC (pandas ewm and an exact Decimal calculation agree)', () => {
    expect(last(computeEMA(real, 20, 'close', 'first'))).toBeCloseTo(73342.914264, 5);
    expect(last(computeEMA(real, 5, 'close', 'first'))).toBeCloseTo(73429.147754, 5);
    expect(computeEMA(real, 20, 'close', 'first')[0].value).toBe(74132.1);
    expect(last(computeEMA(real, 20, 'close', 'first'), 1)).toBeCloseTo(73327.642081, 5);
  });
  it('EMA, SMA start (TA-Lib): 20 / 5 / first point / 16:16 UTC', () => {
    expect(last(computeEMA(real, 20, 'close', 'sma'))).toBeCloseTo(73346.247551, 5);
    expect(last(computeEMA(real, 5, 'close', 'sma'))).toBeCloseTo(73429.147754, 5);
    expect(computeEMA(real, 20, 'close', 'sma')[0].value).toBeCloseTo(73521.755, 5);
    expect(last(computeEMA(real, 20, 'close', 'sma'), 1)).toBeCloseTo(73331.326241, 5);
  });
  it('the two starts give EMA 20 values 3.33 dollars apart on this data', () => {
    expect(last(computeEMA(real, 20, 'close', 'sma')) - last(computeEMA(real, 20, 'close', 'first'))).toBeCloseTo(3.333287, 5);
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

describe('settleBars: how much history a recursive indicator needs to forget where it started', () => {
  // worked out independently in Python: warm-up + ceil(ln(0.001) / ln(1 - alpha)) + 1, alpha = 2 / (period + 1) for the EMA, 1 / period for the RSI
  it.each([
    ['ema', 20, undefined, 71], ['ema', 200, undefined, 692], ['ema', 5, undefined, 19], ['ema', 1, undefined, 1], ['ema', 2, undefined, 8],
    ['rsi', 14, undefined, 109], ['rsi', 1, undefined, 2], ['rsi', 2, undefined, 13],
    ['ema', 20, { start: 'sma' }, 90], ['ema', 200, { start: 'sma' }, 891],
  ])('%s(%i) %j needs %i bars', (kind, period, options, bars) => {
    expect(settleBars(kind, period, options)).toBe(bars);
  });
  it('SMA and Bollinger Bands do not depend on where the history starts', () => {
    for (const period of [1, 20, 200]) {
      expect(settleBars('sma', period)).toBe(0);
      expect(settleBars('bb', period)).toBe(0);
    }
  });
  it('after exactly that many bars the start has faded to the tolerance, one bar earlier it had not', () => {
    for (const [kind, period] of [['ema', 9], ['ema', 20], ['ema', 50], ['ema', 200], ['rsi', 7], ['rsi', 14], ['rsi', 50]]) {
      const alpha = kind === 'ema' ? 2 / (period + 1) : 1 / period;
      const n = settleBars(kind, period) - (kind === 'rsi' ? period : 0) - 1; // bars of fading after the first value
      expect((1 - alpha) ** n).toBeLessThanOrEqual(1e-3);
      expect((1 - alpha) ** (n - 1)).toBeGreaterThan(1e-3);
    }
  });
  it('a tighter tolerance needs more bars, a looser one fewer', () => {
    expect(settleBars('ema', 20, { tolerance: 1e-6 })).toBeGreaterThan(settleBars('ema', 20));
    expect(settleBars('ema', 20, { tolerance: 1e-1 })).toBeLessThan(settleBars('ema', 20));
  });
  it.each([0, -1, 1, 1.1, NaN, Infinity, -Infinity, '0.001'])('rejects invalid settling tolerance %s', (tolerance) => {
    expect(() => settleBars('ema', 20, { tolerance })).toThrow(RangeError);
    expect(() => settleBars('rsi', 14, { tolerance })).toThrow(RangeError);
  });
  it('rejects an invalid EMA seed when calculating settling history', () => {
    expect(() => settleBars('ema', 20, { start: 'unknown' })).toThrow(RangeError);
  });
  it('grows with the period', () => {
    for (const kind of ['ema', 'rsi']) {
      let previous = 0;
      for (let period = 1; period <= 300; period++) {
        const bars = settleBars(kind, period);
        expect(bars).toBeGreaterThanOrEqual(previous);
        previous = bars;
      }
    }
  });
  it('the EMA values really do keep the start: with the settle count the two EMA starts agree to the tolerance', () => {
    const data = generateCandles({ seed: 9, count: 400 });
    const first = computeEMA(data, 20, 'close', 'first');
    const sma = computeEMA(data, 20, 'close', 'sma');
    const gap0 = Math.abs(first[19].value - sma[0].value);
    const atSettle = Math.abs(first[settleBars('ema', 20, { start: 'sma' }) - 1].value - sma[settleBars('ema', 20, { start: 'sma' }) - 20].value);
    expect(atSettle).toBeLessThanOrEqual(gap0 * 1e-3 * 1.0001);
  });
  it.each([0, -1, 1.5, NaN])('rejects the period %s', (period) => {
    expect(() => settleBars('ema', period)).toThrow(RangeError);
  });
});

describe('minBars: when does the first value appear', () => {
  it.each([
    ['sma', 20, undefined, 20], ['sma', 1, undefined, 1], ['bb', 20, undefined, 20], ['bb', 200, undefined, 200],
    ['ema', 20, undefined, 1], ['ema', 20, { start: 'first' }, 1], ['ema', 20, { start: 'sma' }, 20], ['ema', 1, { start: 'sma' }, 1],
    ['rsi', 14, undefined, 15], ['rsi', 1, undefined, 2],
  ])('%s(%i) %j needs %i bars', (kind, period, options, bars) => {
    expect(minBars(kind, period, options)).toBe(bars);
  });

  // the property that matters: the first point of the line is on exactly that bar, and one bar fewer gives no line at all
  const params = { period: 14, mult: 2, start: 'first' };
  for (const [kind, period, start] of [['sma', 5, 'first'], ['sma', 20, 'first'], ['bb', 9, 'first'], ['ema', 7, 'first'], ['ema', 7, 'sma'], ['ema', 30, 'sma'], ['rsi', 5, 'first'], ['rsi', 14, 'first']]) {
    it(`${kind}(${period}) start ${start}: the line begins at bar number ${minBars(kind, period, { start })}, not earlier`, () => {
      const candles = generateCandles({ seed: 4, count: 80 });
      const lines = computeIndicator(kind, candles, { ...params, period, start }, 'close');
      const first = Math.min(...Object.values(lines).map((l) => candles.findIndex((c) => c.time === l[0].time)));
      expect(first + 1).toBe(minBars(kind, period, { start }));
      const fewer = computeIndicator(kind, candles.slice(0, minBars(kind, period, { start }) - 1), { ...params, period, start }, 'close');
      expect(Object.values(fewer).every((l) => l.length === 0)).toBe(true);
      const exactly = computeIndicator(kind, candles.slice(0, minBars(kind, period, { start })), { ...params, period, start }, 'close');
      expect(Object.values(exactly).every((l) => l.length === 1)).toBe(true);
    });
  }
  it.each([0, -1, 1.5, NaN])('rejects the period %s', (period) => {
    expect(() => minBars('sma', period)).toThrow(RangeError);
  });
  it('rejects an invalid EMA seed', () => {
    expect(() => minBars('ema', 20, { start: 'unknown' })).toThrow(RangeError);
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
