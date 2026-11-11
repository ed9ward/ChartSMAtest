import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createIndicatorEngine } from '../../src/indicator-engine.js';

// The engine is what draws the chart. Here it is held against TA-Lib and pandas (the reference file), on every data set,
// both ways it is used: all candles at once (a settings change) and bar by bar with a forming candle (the live stream).
const reference = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
const TOLERANCE = 1e-8;   // relative, as in the comparison on the self-check page
const MULT = 2;

const paramsOf = (s) => ({ period: s.period, mult: MULT, start: s.seed ?? 'first' });

// Compares what the engine produced with the reference series. Returns the counts and the worst relative difference.
export function compareToReference(data, series, candles) {
  const out = { compared: 0, mismatched: 0, missing: 0, extra: 0, worst: 0 };
  for (const [line, theirs] of Object.entries(series.lines)) {
    const scale = Math.max(0, ...theirs.filter(Number.isFinite).map(Math.abs));
    const ours = new Map((data[line] ?? []).map((p) => [p.time, p.value]));
    if (ours.size !== (data[line] ?? []).length) out.extra++; // the same time twice
    candles.forEach((c, i) => {
      const want = theirs[i];
      const got = ours.get(c.time);
      if (want === null || want === undefined) { if (got !== undefined) out.extra++; return; }
      if (got === undefined) { out.missing++; return; }
      out.compared++;
      const e = Math.abs(got - want) / Math.max(Math.abs(want), 1e-3 * scale);
      out.worst = Math.max(out.worst, e);
      if (e > TOLERANCE) out.mismatched++;
    });
    const known = new Set(candles.map((c) => c.time));
    for (const time of ours.keys()) if (!known.has(time)) out.extra++;
  }
  return out;
}

// The engine fed the way the live chart feeds it: a history first, then every new bar twice (partly formed, then final).
function runLive(series, candles) {
  const params = paramsOf(series);
  const warm = Math.min(candles.length - 1, Math.max(5, Math.floor(candles.length / 3)));
  const engine = createIndicatorEngine(series.indicator, candles.slice(0, warm), params, series.source);
  for (const c of candles.slice(warm)) {
    const mid = (c.open + c.close) / 2;
    engine.upsert({ ...c, close: mid, high: Math.max(c.high, mid), low: Math.min(c.low, mid), volume: c.volume / 2 });
    engine.upsert(c);
  }
  return engine.data();
}

const totals = { whole: 0, live: 0 };

describe('the engine against TA-Lib and pandas', () => {
  for (const dataset of reference.datasets) {
    for (const mode of ['whole', 'live']) {
      it(`${dataset.id} (${dataset.candles.length} bars, ${dataset.series.length} series), ${mode === 'whole' ? 'all candles at once' : 'bar by bar with a forming candle'}`, () => {
        let compared = 0;
        for (const series of dataset.series) {
          const data = mode === 'whole'
            ? createIndicatorEngine(series.indicator, dataset.candles, paramsOf(series), series.source).data()
            : runLive(series, dataset.candles);
          const r = compareToReference(data, series, dataset.candles);
          const label = `${series.indicator}${series.seed ? `/${series.seed}` : ''} ${series.source} period ${series.period}`;
          expect(r.missing, `${label}: points the reference has and the engine does not`).toBe(0);
          expect(r.extra, `${label}: points the engine has and the reference does not`).toBe(0);
          expect(r.mismatched, `${label}: points outside ${TOLERANCE} (worst ${r.worst})`).toBe(0);
          expect(r.worst, label).toBeLessThan(1e-9);   // far inside the tolerance: drift shows up here first
          compared += r.compared;
        }
        expect(compared).toBeGreaterThan(1000);
        totals[mode] += compared;
      });
    }
  }

  it('together that is well over 150 000 points, so the comparison is not vacuous', () => {
    expect(totals.whole).toBeGreaterThan(80_000);
    expect(totals.live).toBe(totals.whole);
  });
});

describe('the comparison itself can fail', () => {
  const dataset = reference.datasets.find((d) => d.id === 'real50');
  const series = dataset.series.find((s) => s.indicator === 'bb' && s.period === 14 && s.source === 'close');
  const good = () => createIndicatorEngine(series.indicator, dataset.candles, paramsOf(series), series.source).data();

  it('passes for the engine as it is', () => {
    const r = compareToReference(good(), series, dataset.candles);
    expect(r).toMatchObject({ mismatched: 0, missing: 0, extra: 0 });
    expect(r.compared).toBeGreaterThan(100);
  });
  it('a difference of one millionth is noticed', () => {
    const data = good();
    data.upper[5] = { ...data.upper[5], value: data.upper[5].value * (1 + 1e-6) };
    expect(compareToReference(data, series, dataset.candles).mismatched).toBe(1);
  });
  it('a point that is missing is noticed', () => {
    const data = good();
    data.basis.splice(7, 1);
    expect(compareToReference(data, series, dataset.candles).missing).toBe(1);
  });
  it('a point too many is noticed', () => {
    const data = good();
    data.lower.unshift({ time: dataset.candles[0].time, value: 1 });
    expect(compareToReference(data, series, dataset.candles).extra).toBeGreaterThan(0);
  });
  it('a point twice is noticed', () => {
    const data = good();
    data.upper.push({ ...data.upper.at(-1) });
    expect(compareToReference(data, series, dataset.candles).extra).toBeGreaterThan(0);
  });
  it('a swapped pair of bands is noticed', () => {
    const data = good();
    [data.upper, data.lower] = [data.lower, data.upper];
    expect(compareToReference(data, series, dataset.candles).mismatched).toBeGreaterThan(50);
  });
});
