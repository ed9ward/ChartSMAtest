import { describe, it, expect } from 'vitest';
import { computeSMA, sourceValue, SOURCES } from '../../src/sma.js';
import { generateCandles } from '../../src/generator.js';
import { refSMA, expectSeriesClose } from './helpers.js';

const candles = generateCandles({ seed: 42, count: 120 });
const candle = (time, o, h, l, c, v = 100) => ({ time, open: o, high: h, low: l, close: c, volume: v });

describe('SMA matches the reference for every source and period', () => {
  for (const source of SOURCES) {
    for (const period of [1, 2, 5, 20, 119, 120]) {
      it(`${source}, period ${period}`, () => {
        expectSeriesClose(computeSMA(candles, period, source), refSMA(candles, period, source));
      });
    }
  }
});

describe('SMA known values (hand-calculated)', () => {
  const data = [candle(1, 10, 12, 8, 11), candle(2, 11, 15, 9, 13), candle(3, 13, 14, 10, 12)];
  it('close period 2', () => {
    expect(computeSMA(data, 2, 'close')).toEqual([{ time: 2, value: 12 }, { time: 3, value: 12.5 }]);
  });
  it('hl2 / hlc3 / ohlc4 of one candle', () => {
    const c = candle(1, 10, 14, 6, 12);
    expect(sourceValue(c, 'hl2')).toBe(10);
    expect(sourceValue(c, 'hlc3')).toBeCloseTo(32 / 3, 10);
    expect(sourceValue(c, 'ohlc4')).toBe(10.5);
  });
  it('volume source', () => {
    expect(computeSMA([candle(1, 1, 1, 1, 1, 10), candle(2, 1, 1, 1, 1, 30)], 2, 'volume')).toEqual([{ time: 2, value: 20 }]);
  });
});

describe('period edge cases', () => {
  it('period 1 equals the source itself', () => {
    expect(computeSMA(candles, 1, 'close').map((p) => p.value)).toEqual(candles.map((c) => c.close));
  });
  it('period longer than data gives an empty series (no crash)', () => {
    expect(computeSMA(candles, 121, 'close')).toEqual([]);
  });
  it('first point appears exactly at index period-1', () => {
    expect(computeSMA(candles, 10, 'close')[0].time).toBe(candles[9].time);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid period %s', (period) => {
    expect(() => computeSMA(candles, period, 'close')).toThrow(RangeError);
  });
  it('rejects an unknown source', () => {
    expect(() => computeSMA(candles, 5, 'vwap')).toThrow(/Unknown SMA source/);
  });
  it('empty input gives an empty series', () => {
    expect(computeSMA([], 5, 'close')).toEqual([]);
  });
});

describe('strange values', () => {
  it('negative prices are averaged normally', () => {
    const neg = candles.map((c) => ({ ...c, open: c.open - 500, high: c.high - 500, low: c.low - 500, close: c.close - 500 }));
    expectSeriesClose(computeSMA(neg, 10, 'ohlc4'), refSMA(neg, 10, 'ohlc4'));
    expect(computeSMA(neg, 10, 'close').every((p) => p.value < 0)).toBe(true);
  });
  it('zero prices', () => {
    const zero = [candle(1, 0, 0, 0, 0), candle(2, 0, 0, 0, 0)];
    expect(computeSMA(zero, 2, 'close')).toEqual([{ time: 2, value: 0 }]);
  });
  it('very large values keep relative precision', () => {
    const big = candles.map((c) => ({ ...c, close: c.close * 1e10 }));
    expectSeriesClose(computeSMA(big, 10, 'close'), refSMA(big, 10, 'close'), 9);
  });
  it('sum overflow produces a gap, not Infinity', () => {
    const max = Number.MAX_VALUE;
    const out = computeSMA([candle(1, max, max, max, max), candle(2, max, max, max, max)], 2, 'close');
    expect(out).toEqual([]);
  });
  it.each([NaN, null, undefined, Infinity, -Infinity, '5'])('a bad value (%s) leaves a gap only where it is in the window', (bad) => {
    const data = candles.slice(0, 10).map((c) => ({ ...c }));
    data[5].close = bad;
    const out = computeSMA(data, 3, 'close');
    const times = out.map((p) => p.time);
    // windows ending at index 5, 6, 7 contain the bad candle
    for (const i of [5, 6, 7]) expect(times).not.toContain(data[i].time);
    for (const i of [2, 3, 4, 8, 9]) expect(times).toContain(data[i].time);
    expect(out.every((p) => Number.isFinite(p.value))).toBe(true);
  });
});

describe('realtime: a forming candle changes only the last SMA point', () => {
  it('updating the last candle', () => {
    const data = candles.slice(0, 50).map((c) => ({ ...c }));
    const before = computeSMA(data, 20, 'close');
    for (const close of [90, 95.5, 101.25]) {
      data[49].close = close;
      const after = computeSMA(data, 20, 'close');
      expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
      expect(after.at(-1).value).toBeCloseTo(refSMA(data, 20, 'close').at(-1).value, 8);
    }
  });
  it('appending a new candle shifts the window by one', () => {
    const data = candles.slice(0, 40);
    const before = computeSMA(data, 10, 'hl2');
    const after = computeSMA(candles.slice(0, 41), 10, 'hl2');
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1).time).toBe(candles[40].time);
  });
});

describe('long series', () => {
  const long = generateCandles({ seed: 42, count: 2000 });
  it.each([['close', 200], ['ohlc4', 50], ['volume', 1999]])('%s, period %i matches the reference', (source, period) => {
    expectSeriesClose(computeSMA(long, period, source), refSMA(long, period, source));
  });
  it('2000 bars with period 200 are computed fast', () => {
    const t = performance.now();
    computeSMA(long, 200, 'ohlc4');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
