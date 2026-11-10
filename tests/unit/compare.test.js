import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareLine, mergeStats, compareIndicator, IDENTICAL } from '../../checks/compare.js';
import { computeIndicator } from '../../src/indicators.js';

const times = [10, 20, 30, 40, 50];
const pts = (...values) => values.map((v, i) => (v === undefined ? null : { time: times[i], value: v })).filter(Boolean);

describe('compareLine statistics', () => {
  it('identical values', () => {
    const s = compareLine(pts(1, 2, 3, 4, 5), [1, 2, 3, 4, 5], times);
    expect(s).toMatchObject({ compared: 5, identical: 5, cents: 5, missing: 0, extra: 0, maxDiff: 0, sumDiff: 0, worst: null });
  });
  it('floating point noise still counts as identical', () => {
    const s = compareLine(pts(73310.66350000001, 2), [73310.6635, 2], times);
    expect(s.identical).toBe(2);
  });
  it('a difference of 0.004 is "to the cent" but not identical', () => {
    const s = compareLine(pts(100.004, 2, 3), [100, 2, 3], times);
    expect(s).toMatchObject({ compared: 3, identical: 2, cents: 3 });
    expect(s.maxDiff).toBeCloseTo(0.004, 12);
    expect(s.worst).toEqual({ time: 10, ours: 100.004, theirs: 100 });
  });
  it('a difference of 0.01 is neither', () => {
    const s = compareLine(pts(100.01), [100], times);
    expect(s).toMatchObject({ compared: 1, identical: 0, cents: 0 });
  });
  it('just over half a cent is not "to the cent"', () => {
    expect(compareLine(pts(100.0051), [100], times).cents).toBe(0);
    expect(compareLine(pts(100.0049), [100], times).cents).toBe(1);
  });
  it('relative tolerance for big numbers, absolute for small ones', () => {
    expect(compareLine(pts(1e9 + 5), [1e9], times).identical).toBe(1); // 5 on 1e9 is 5e-9 relative
    expect(compareLine(pts(1e9 + 50), [1e9], times).identical).toBe(0);
    expect(compareLine(pts(1e-9), [0], times).identical).toBe(1);      // absolute below 1
    expect(IDENTICAL).toBe(1e-8);
  });
  it('values the app does not have are counted as missing, extra ones as extra', () => {
    const s = compareLine(pts(1, undefined, 3, 4), [1, 2, 3, 4, null], times.slice(0, 5));
    expect(s).toMatchObject({ compared: 3, missing: 1, extra: 0 });
    const t = compareLine(pts(1, 2, 3, 4, 5), [null, null, 3, 4, 5], times);
    expect(t).toMatchObject({ compared: 3, extra: 2, missing: 0 });
  });
  it('points are matched by time, not by position', () => {
    const shifted = [{ time: 20, value: 1 }, { time: 30, value: 2 }];
    const s = compareLine(shifted, [1, 2, null, null, null], times);
    expect(s).toMatchObject({ compared: 1, identical: 0, missing: 1, extra: 1 }); // t=10 missing; t=20 differs (1 vs 2); t=30 extra
  });
  it('mean and max difference', () => {
    const merged = mergeStats([compareLine(pts(1, 2), [2, 4], times), compareLine(pts(10), [10], times)]);
    expect(merged.compared).toBe(3);
    expect(merged.maxDiff).toBe(2);
    expect(merged.meanDiff).toBeCloseTo(1, 12);
    expect(merged.series).toBe(2);
  });
  it('nothing compared gives mean 0, not NaN', () => {
    expect(mergeStats([compareLine([], [null, null, null, null, null], times)]).meanDiff).toBe(0);
  });
});

describe('the TA-Lib reference file', () => {
  const ref = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
  it('has both datasets with consistent array lengths', () => {
    expect(ref.datasets.map((d) => d.id)).toEqual(['real50', 'walk300']);
    expect(ref.generatedWith['TA-Lib']).toBeTruthy();
    for (const d of ref.datasets) {
      expect(d.series.length).toBeGreaterThan(20);
      for (const s of d.series) for (const values of Object.values(s.lines)) expect(values).toHaveLength(d.candles.length);
    }
  });
  it('the real data is the Binance fixture', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
    const d = ref.datasets[0];
    expect(d.candles).toHaveLength(raw.length);
    expect(d.candles[0].time).toBe(raw[0][0] / 1000);
    expect(d.candles.at(-1).close).toBe(parseFloat(raw.at(-1)[4]));
  });
  it('warm-up values are empty like in every indicator', () => {
    const sma5 = ref.datasets[0].series.find((s) => s.indicator === 'sma' && s.source === 'close' && s.period === 5);
    expect(sma5.lines.sma.slice(0, 4)).toEqual([null, null, null, null]);
    expect(sma5.lines.sma[4]).not.toBeNull();
  });

  for (const dataset of ref.datasets) {
    for (const [indicator, start] of [['sma'], ['ema', 'first'], ['ema', 'sma'], ['bb'], ['rsi']]) {
      it(`${indicator}${start ? ` (${start} start)` : ''} on ${dataset.id}: every value is identical to the reference library`, () => {
        const s = compareIndicator(dataset, indicator, start);
        expect(s.compared).toBeGreaterThan(500);
        expect(s.reference).toBe(start === 'first' ? 'pandas' : 'TA-Lib');
        expect(s.missing).toBe(0);
        expect(s.extra).toBe(0);
        expect(s.identical).toBe(s.compared);
        expect(s.cents).toBe(s.compared);
        expect(s.maxDiff).toBeLessThan(1e-8);
      });
    }
  }

  it('the EMA with the first value as start really differs from TA-Lib at the start, by exactly the decaying seed term', () => {
    const d = ref.datasets[0];
    const times = d.candles.map((c) => c.time);
    const find = (seed) => d.series.find((x) => x.indicator === 'ema' && x.seed === seed && x.source === 'close' && x.period === 20);
    const pandas = find('first').lines.ema;   // from index 0
    const talib = find('sma').lines.ema;      // from index 19
    const a = 2 / 21;
    const gap0 = pandas[19] - talib[19];
    expect(Math.abs(gap0)).toBeGreaterThan(1);                 // visible, not rounding noise
    for (let t = 19; t < times.length; t++) expect(pandas[t] - talib[t]).toBeCloseTo((1 - a) ** (t - 19) * gap0, 7);
    // and our two starts reproduce both libraries
    expect(compareLine(computeIndicator('ema', d.candles, { period: 20, start: 'first' }, 'close').ema, pandas, times).identical).toBe(times.length);
    expect(compareLine(computeIndicator('ema', d.candles, { period: 20, start: 'sma' }, 'close').ema, talib, times).identical).toBe(times.length - 19);
  });

  it('the comparison notices a wrong implementation (period shifted by one)', () => {
    const d = ref.datasets[0];
    const times2 = d.candles.map((c) => c.time);
    const series = d.series.find((s) => s.indicator === 'sma' && s.source === 'close' && s.period === 14);
    const wrong = computeIndicator('sma', d.candles, { period: 13 }, 'close').sma;
    const s = compareLine(wrong, series.lines.sma, times2);
    expect(s.identical).toBeLessThan(s.compared);
    expect(s.extra).toBeGreaterThan(0);
  });
});
