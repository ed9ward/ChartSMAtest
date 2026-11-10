import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareLine, mergeStats, compareIndicator, comparisonProblem, IDENTICAL } from '../../checks/compare.js';
import { REFERENCE_SPEC, verifyReference, expectedKeys, seriesKey, warmup } from '../../checks/reference-spec.js';
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
  describe('everything that is not an exact match is counted', () => {
    it('a timestamp used twice is a duplicate; only the first one is compared', () => {
      const s = compareLine([{ time: 10, value: 1 }, { time: 10, value: 999 }, { time: 20, value: 2 }], [1, 2, null, null, null], times);
      expect(s).toMatchObject({ compared: 2, identical: 2, duplicates: 1, unordered: 0, missing: 0, extra: 0, outside: 0 });
    });
    it('duplicates that are not next to each other are found too, and the disorder with them', () => {
      const s = compareLine([{ time: 10, value: 1 }, { time: 20, value: 2 }, { time: 10, value: 1 }], [1, 2, null, null, null], times);
      expect(s).toMatchObject({ duplicates: 1, unordered: 1 });
    });
    it('three points on one timestamp are two duplicates', () => {
      expect(compareLine(pts(1, 2).concat(pts(1)[0], pts(1)[0]), [1, 2, null, null, null], times).duplicates).toBe(2);
    });
    it('a point with a timestamp that is not in the reference at all is "outside", even if every reference value matched', () => {
      const s = compareLine([...pts(1, 2, 3, 4, 5), { time: 999, value: 7 }], [1, 2, 3, 4, 5], times);
      expect(s).toMatchObject({ compared: 5, identical: 5, outside: 1, extra: 0, missing: 0 });
    });
    it('points before and after the whole reference range are outside as well', () => {
      const s = compareLine([{ time: -5, value: 1 }, ...pts(1, 2, 3, 4, 5), { time: 60, value: 1 }], [1, 2, 3, 4, 5], times);
      expect(s.outside).toBe(2);
    });
    it('an outside point repeated is one outside point and one duplicate', () => {
      const s = compareLine([...pts(1), { time: 999, value: 1 }, { time: 999, value: 1 }], [1, null, null, null, null], times);
      expect(s).toMatchObject({ outside: 1, duplicates: 1 });
    });
    it('points not in ascending order are counted (the chart would refuse them)', () => {
      const s = compareLine([{ time: 30, value: 3 }, { time: 10, value: 1 }, { time: 20, value: 2 }], [1, 2, 3, null, null], times);
      expect(s).toMatchObject({ unordered: 2, compared: 3, identical: 3 });
    });
    it('strictly ascending points have none of these problems', () => {
      expect(compareLine(pts(1, 2, 3, 4, 5), [1, 2, 3, 4, 5], times)).toMatchObject({ duplicates: 0, unordered: 0, outside: 0, extra: 0, missing: 0, expected: 5 });
    });
    it('a NaN from the app is compared, and is not identical', () => {
      const s = compareLine(pts(NaN, 2), [1, 2, null, null, null], times);
      expect(s).toMatchObject({ compared: 2, identical: 1, cents: 1 });
    });
    it('an app with no points at all misses every reference value', () => {
      expect(compareLine([], [1, 2, null, 4, null], times)).toMatchObject({ expected: 3, missing: 3, compared: 0 });
    });
    it('an undefined reference value is the same as null', () => {
      expect(compareLine(pts(1, 2, 3), [1, undefined, null], times)).toMatchObject({ expected: 1, extra: 2 });
    });
    it('the counts add up: expected = compared + missing', () => {
      const s = compareLine(pts(1, 9, undefined, 4), [1, 2, 3, 4, 5], times);
      expect(s.expected).toBe(s.compared + s.missing);
    });
    it('merging adds every counter', () => {
      const a = compareLine([{ time: 10, value: 1 }, { time: 10, value: 1 }, { time: 999, value: 1 }], [1, 2, null, null, null], times);
      const b = compareLine([{ time: 30, value: 3 }, { time: 10, value: 1 }], [1, null, 3, null, null], times);
      const m = mergeStats([a, b]);
      expect(m).toMatchObject({ duplicates: 1, outside: 1, unordered: 1, missing: 1, expected: 4, compared: 3 });
    });
  });

  describe('comparisonProblem: when a comparison is not a success', () => {
    const clean = () => ({ ...mergeStats([compareLine(pts(1, 2), [1, 2, null, null, null], times)]), problems: [] });
    it('a clean comparison has no problem', () => {
      expect(comparisonProblem(clean())).toBeNull();
    });
    it.each([
      ['missing', { missing: 1, compared: 1 }, /1 missing/],
      ['extra', { extra: 2 }, /2 extra/],
      ['outside', { outside: 1 }, /1 outside/],
      ['duplicates', { duplicates: 3 }, /3 duplicates/],
      ['unordered', { unordered: 1 }, /1 unordered/],
    ])('%s makes it a failure, even if everything compared is identical', (_, patch, message) => {
      expect(comparisonProblem({ ...clean(), ...patch })).toMatch(message);
    });
    it('nothing compared is a failure', () => {
      expect(comparisonProblem({ ...clean(), compared: 0, identical: 0, expected: 0 })).toBe('nothing was compared');
    });
    it('values that differ are reported with the worst one', () => {
      const bad = { ...mergeStats([compareLine(pts(1, 2.5), [1, 2, null, null, null], times)]), problems: [] };
      expect(comparisonProblem(bad)).toMatch(/1 of 2 values differ.*"ours":2.5/);
    });
    it('a structural problem comes first and is counted', () => {
      expect(comparisonProblem({ ...clean(), problems: ['series x is missing', 'series y is missing'] })).toMatch(/2 problem\(s\).*series x is missing/);
    });
    it('compared must equal expected', () => {
      expect(comparisonProblem({ ...clean(), expected: 5 })).toMatch(/2 of 5 reference values were compared/);
    });
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

describe('the reference file is complete', () => {
  const ref = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
  const clone = () => JSON.parse(JSON.stringify(ref));
  const real = (r) => r.datasets[0];
  const sma5 = (r) => real(r).series.find((x) => x.indicator === 'sma' && x.source === 'close' && x.period === 5);
  const problemsOf = (mutate) => { const r = clone(); mutate(r); return verifyReference(r); };

  it('has no problems', () => {
    expect(verifyReference(ref)).toEqual([]);
  });

  it('has exactly the expected number of series, worked out from the grid (sources x periods x variants)', () => {
    expect(REFERENCE_SPEC.variants).toHaveLength(5);
    expect(ref.datasets.map((d) => d.series.length)).toEqual([8 * 3 * 5, 3 * 3 * 5]);
    expect(ref.datasets.map((d) => d.series.length)).toEqual([120, 45]);
    for (const [i, d] of ref.datasets.entries()) {
      const spec = REFERENCE_SPEC.datasets[i];
      expect(d.series.length).toBe(spec.sources.length * spec.periods.length * REFERENCE_SPEC.variants.length);
    }
  });

  it('has every indicator variant in the same number on every dataset', () => {
    for (const [indicator, seed] of [['sma'], ['ema', 'first'], ['ema', 'sma'], ['bb'], ['rsi']]) {
      expect(real(ref).series.filter((x) => x.indicator === indicator && x.seed === seed)).toHaveLength(24);
      expect(ref.datasets[1].series.filter((x) => x.indicator === indicator && x.seed === seed)).toHaveLength(9);
    }
  });

  it('has every combination of indicator, start, source and period exactly once', () => {
    for (const [i, d] of ref.datasets.entries()) {
      const keys = d.series.map(seriesKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual([...expectedKeys(REFERENCE_SPEC.datasets[i])].sort());
    }
  });

  it('has the sources and periods the two datasets are meant to cover', () => {
    expect([...new Set(real(ref).series.map((x) => x.source))]).toEqual(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4']);
    expect([...new Set(real(ref).series.map((x) => x.period))]).toEqual([5, 14, 20]);
    expect([...new Set(ref.datasets[1].series.map((x) => x.period))]).toEqual([14, 50, 200]);
    expect([...new Set(ref.datasets[1].series.map((x) => x.source))]).toEqual(['close', 'hlc3', 'volume']);
  });

  it('has every line of every indicator in every series, with one value (or an empty warm-up) per candle', () => {
    for (const d of ref.datasets) for (const s of d.series) {
      const lines = s.indicator === 'bb' ? ['basis', 'lower', 'upper'] : [s.indicator];
      expect(Object.keys(s.lines).sort()).toEqual(lines);
      for (const values of Object.values(s.lines)) {
        expect(values).toHaveLength(d.candles.length);
        const first = warmup(REFERENCE_SPEC.variants.find((v) => v.indicator === s.indicator && v.seed === s.seed), s.period);
        expect(values.findIndex((v) => v !== null)).toBe(first);
        expect(values.slice(first).every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('has all the RSI edge-case scenarios, by title', () => {
    expect(ref.rsiEdge.map((e) => e.title)).toEqual(REFERENCE_SPEC.rsiEdge);
    expect(ref.rsiEdge).toHaveLength(15);
  });

  it('carries the same specification that the tests expect (declared separately in Python and in JS)', () => {
    expect(ref.spec).toEqual(REFERENCE_SPEC);
  });

  describe('verifyReference notices', () => {
    it.each([
      ['a missing series', (r) => { real(r).series.splice(7, 1); }, /series .* is missing/],
      ['a whole indicator variant missing', (r) => { real(r).series = real(r).series.filter((x) => x.indicator !== 'rsi'); }, /rsi.* is missing/],
      ['a series appearing twice', (r) => { real(r).series.push(JSON.parse(JSON.stringify(real(r).series[3]))); }, /appears 2 times/],
      ['a series nobody asked for', (r) => { real(r).series.push({ ...JSON.parse(JSON.stringify(sma5(r))), period: 7 }); }, /unexpected series sma\|-\|close\|7/],
      ['a series with a source that is not on the list', (r) => { sma5(r).source = 'vwap'; }, /unexpected series .*vwap|is missing/],
      ['a line that is too short', (r) => { sma5(r).lines.sma.pop(); }, /49 values for 50 candles/],
      ['a line that is too long', (r) => { sma5(r).lines.sma.push(1); }, /51 values for 50 candles/],
      ['a Bollinger band missing', (r) => { delete real(r).series.find((x) => x.indicator === 'bb').lines.upper; }, /lines are .* expected/],
      ['a line that the indicator does not have', (r) => { sma5(r).lines.extra = sma5(r).lines.sma; }, /lines are/],
      ['a hole in the middle of a line', (r) => { sma5(r).lines.sma[30] = null; }, /bar 30 has no value/],
      ['a value where the warm-up should be empty', (r) => { sma5(r).lines.sma[0] = 1; }, /bar 0 should still be empty/],
      ['a line that starts one bar late', (r) => { sma5(r).lines.sma[4] = null; }, /bar 4 has no value/],
      ['a NaN value', (r) => { sma5(r).lines.sma[40] = NaN; }, /bar 40 has no value|expected/],
      ['the wrong reference library name', (r) => { real(r).series.find((x) => x.seed === 'first').reference = 'TA-Lib'; }, /reference is "TA-Lib", expected "pandas"/],
      ['the wrong Bollinger multiplier', (r) => { real(r).series.find((x) => x.indicator === 'bb').mult = 3; }, /mult is 3, expected 2/],
      ['too few candles', (r) => { real(r).candles.pop(); }, /49 candles, expected 50/],
      ['candle times that repeat', (r) => { real(r).candles[10].time = real(r).candles[9].time; }, /not strictly increasing/],
      ['an impossible candle', (r) => { real(r).candles[5].high = real(r).candles[5].low - 1; }, /candle 5 is not valid/],
      ['a missing library version', (r) => { delete r.generatedWith.pandas; }, /no version of pandas/],
      ['a changed specification', (r) => { r.spec.datasets[0].periods = [5, 14]; }, /specification written into the file differs/],
      ['a missing dataset', (r) => { r.datasets.pop(); }, /datasets are/],
      ['an RSI scenario missing', (r) => { r.rsiEdge.pop(); }, /RSI edge scenarios/],
      ['an RSI scenario renamed', (r) => { r.rsiEdge[2].title = 'only rising'; }, /RSI edge scenarios/],
      ['RSI values of the wrong length', (r) => { r.rsiEdge[0].tradingview.pop(); }, /tradingview has/],
      ['an RSI value in the warm-up', (r) => { r.rsiEdge[2].tradingview[0] = 100; }, /tradingview bar 0 should not have a value/],
      ['TA-Lib values for a period it cannot do', (r) => { r.rsiEdge.at(-1).talib = [1, 2, 3, 4, 5, 6]; }, /TA-Lib cannot do a period below 2/],
      ['TA-Lib missing for a period it can do', (r) => { r.rsiEdge[0].talib = null; }, /talib has/],
      ['unsorted flat bars', (r) => { r.rsiEdge[0].flatBars = [5, 4]; }, /flatBars are not a sorted list/],
    ])('%s', (_, mutate, message) => {
      const problems = problemsOf(mutate);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join('\n')).toMatch(message);
    });
  });

  it('has no problems of its own when every dataset and scenario is checked in turn (sanity of the tamper helper)', () => {
    expect(problemsOf(() => {})).toEqual([]);
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

  // How many reference values a comparison must cover, worked out from the specification alone (not from the file)
  const expectedValues = (datasetIndex, variant) => {
    const spec = REFERENCE_SPEC.datasets[datasetIndex];
    const lines = variant.indicator === 'bb' ? 3 : 1;
    return spec.sources.length * lines * spec.periods.reduce((n, period) => n + (spec.candles - warmup(variant, period)), 0);
  };

  for (const [datasetIndex, dataset] of ref.datasets.entries()) {
    for (const [indicator, start] of [['sma'], ['ema', 'first'], ['ema', 'sma'], ['bb'], ['rsi']]) {
      it(`${indicator}${start ? ` (${start} start)` : ''} on ${dataset.id}: every value of every line is identical to the reference library`, () => {
        const variant = REFERENCE_SPEC.variants.find((v) => v.indicator === indicator && v.seed === start);
        const s = compareIndicator(dataset, indicator, start);
        expect(s.problems).toEqual([]);
        expect(comparisonProblem(s)).toBeNull();
        // all of it was compared, not just something: the exact number, from the specification
        expect(s.expected).toBe(expectedValues(datasetIndex, variant));
        expect(s.compared).toBe(s.expected);
        expect(s.series).toBe(dataset.series.filter((x) => x.indicator === indicator && x.seed === start).length * (indicator === 'bb' ? 3 : 1));
        expect(s.reference).toBe(start === 'first' ? 'pandas' : 'TA-Lib');
        expect([s.missing, s.extra, s.outside, s.duplicates, s.unordered]).toEqual([0, 0, 0, 0, 0]);
        expect(s.identical).toBe(s.compared);
        expect(s.cents).toBe(s.compared);
        expect(s.maxDiff).toBeLessThan(1e-8);
      });
    }
  }

  describe('compareIndicator notices a reference that is not what it should be, even when other series are fine', () => {
    const find = (r, f) => real(r).series.find(f);
    const run = (mutate, indicator = 'sma', start) => {
      const r = clone();
      mutate(r);
      return compareIndicator(real(r), indicator, start);
    };

    it('a missing series: the rest still compares, but the comparison is not a success', () => {
      const s = run((r) => { real(r).series.splice(real(r).series.findIndex((x) => x.indicator === 'sma' && x.period === 14 && x.source === 'low'), 1); });
      expect(s.compared).toBeGreaterThan(500);
      expect(s.problems.join()).toMatch(/sma\|-\|low\|14 is missing from the reference/);
      expect(comparisonProblem(s)).toMatch(/problem/);
    });
    it('a series that appears twice', () => {
      const s = run((r) => { real(r).series.push(JSON.parse(JSON.stringify(find(r, (x) => x.indicator === 'sma')))); });
      expect(s.problems.join()).toMatch(/appears 2 times/);
    });
    it('a series nobody asked for', () => {
      const s = run((r) => { real(r).series.push({ ...JSON.parse(JSON.stringify(sma5(r))), period: 7 }); });
      expect(s.problems.join()).toMatch(/sma\|-\|close\|7 is not expected/);
    });
    it('a series whose every reference value is empty: there is nothing to compare', () => {
      const s = run((r) => { sma5(r).lines.sma = sma5(r).lines.sma.map(() => null); });
      expect(s.problems.join()).toMatch(/nothing to compare/);
      expect(s.compared).toBeGreaterThan(500); // the others did compare: that must not hide it
      expect(comparisonProblem(s)).not.toBeNull();
    });
    it('a Bollinger series without one of its lines', () => {
      const s = run((r) => { delete find(r, (x) => x.indicator === 'bb' && x.period === 5).lines.upper; }, 'bb');
      expect(s.problems.join()).toMatch(/the reference has no line "upper"/);
    });
    it('a line in the reference that the indicator does not have', () => {
      const s = run((r) => { sma5(r).lines.signal = sma5(r).lines.sma; });
      expect(s.problems.join()).toMatch(/a line "signal" that sma does not have/);
    });
    it('a dataset that is not in the specification', () => {
      const r = clone();
      real(r).id = 'real51';
      expect(compareIndicator(real(r), 'sma').problems.join()).toMatch(/dataset real51 is not in the specification/);
    });
    it('an EMA variant mixed up: asking for the SMA start finds only SMA-start series', () => {
      const s = run(() => {}, 'ema', 'sma');
      expect(s.problems).toEqual([]);
      expect(s.reference).toBe('TA-Lib');
      const t = run((r) => { for (const x of real(r).series) if (x.seed === 'sma') x.seed = 'first'; }, 'ema', 'sma');
      expect(t.problems.join()).toMatch(/is missing from the reference/);
    });
    it('a value that differs is still found', () => {
      const s = run((r) => { sma5(r).lines.sma[10] += 0.01; });
      expect(s.identical).toBe(s.compared - 1);
      expect(comparisonProblem(s)).toMatch(/1 of \d+ values differ/);
    });
  });

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
