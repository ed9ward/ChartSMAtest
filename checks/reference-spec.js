// What the reference file (tests/fixtures/talib-reference.json) must contain, written down independently of the
// generator (scripts/make-reference.py, which writes the same grid into the file as `spec`). If a series, a line, a value
// or a scenario goes missing, or anything unexpected appears, verifyReference() says so.
import { INDICATORS } from '../src/indicators.js';
import { validateCandle } from '../src/sanitize.js';

const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

export const REFERENCE_SPEC = {
  datasets: [
    { id: 'real50', candles: 50, sources: SOURCES, periods: [5, 14, 20] },
    { id: 'walk300', candles: 300, sources: ['close', 'hlc3', 'volume'], periods: [14, 50, 200] },
    // other scales of prices and a long series, so that nothing is tuned to prices around 100 or 73000
    { id: 'tiny', candles: 300, sources: ['close'], periods: [14, 50] },
    { id: 'huge', candles: 300, sources: ['close'], periods: [14, 50] },
    { id: 'negative', candles: 300, sources: ['close'], periods: [14, 50] },
    { id: 'long2000', candles: 2000, sources: ['close'], periods: [14, 200] },
    { id: 'real500', candles: 500, sources: ['close', 'hlc3', 'volume'], periods: [14, 50, 200] },
  ],
  variants: [
    { indicator: 'sma' },
    { indicator: 'ema', seed: 'first', reference: 'pandas' },
    { indicator: 'ema', seed: 'sma', reference: 'TA-Lib' },
    { indicator: 'bb', mult: 2 },
    { indicator: 'rsi' },
  ],
  rsiEdge: [
    'flat', 'flat, period 14', 'only up', 'only down', 'only up, period 14', 'only down, period 14', 'up, then flat', 'down, then flat',
    'zigzag up, then flat', 'zigzag down, then flat', 'flat, then up', 'flat, then down', 'up, flat, down',
    'period 2, up, then 1300 flat bars (the averages underflow to zero)', 'period 1: up, flat, down',
  ],
  libraries: ['TA-Lib', 'pandas', 'numpy'],
};

export const seriesKey = (s) => `${s.indicator}|${s.seed ?? '-'}|${s.source}|${s.period}`;

// Bars without a value at the start of a series: the warm-up each indicator needs.
export const warmup = (variant, period) => {
  if (variant.indicator === 'rsi') return period;
  if (variant.indicator === 'ema' && variant.seed === 'first') return 0;
  return period - 1;
};

/** Keys of the series the file must hold for one dataset, optionally only for one indicator (and EMA start). */
export function expectedKeys(datasetSpec, indicator, seed) {
  const keys = [];
  for (const variant of REFERENCE_SPEC.variants) {
    if (indicator !== undefined && variant.indicator !== indicator) continue;
    if (seed !== undefined && variant.seed !== seed) continue;
    for (const source of datasetSpec.sources) {
      for (const period of datasetSpec.periods) keys.push(seriesKey({ ...variant, source, period }));
    }
  }
  return keys;
}

const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @returns {string[]} everything that is wrong with the reference file (empty when it is complete and consistent) */
export function verifyReference(ref, spec = REFERENCE_SPEC) {
  const problems = [];
  const add = (message) => problems.push(message);

  for (const lib of spec.libraries) if (!ref?.generatedWith?.[lib]) add(`generatedWith has no version of ${lib}`);
  if (!same(ref?.spec, spec)) add('the specification written into the file differs from the one the tests expect');

  const ids = (ref?.datasets ?? []).map((d) => d.id);
  if (!same(ids, spec.datasets.map((d) => d.id))) add(`datasets are [${ids}], expected [${spec.datasets.map((d) => d.id)}]`);

  for (const dspec of spec.datasets) {
    const d = (ref?.datasets ?? []).find((x) => x.id === dspec.id);
    if (!d) continue;
    const where = `dataset ${d.id}`;
    const n = d.candles?.length;
    if (n !== dspec.candles) add(`${where}: ${n} candles, expected ${dspec.candles}`);
    (d.candles ?? []).forEach((c, i) => {
      if (validateCandle(c)) add(`${where}: candle ${i} is not valid (${validateCandle(c)})`);
      if (i > 0 && !(c.time > d.candles[i - 1].time)) add(`${where}: candle times are not strictly increasing at ${i}`);
    });

    const keys = (d.series ?? []).map(seriesKey);
    const have = count(keys);
    const want = expectedKeys(dspec);
    for (const k of want) if (!have.has(k)) add(`${where}: series ${k} is missing`);
    for (const [k, c] of have) {
      if (!want.includes(k)) add(`${where}: unexpected series ${k}`);
      if (c > 1) add(`${where}: series ${k} appears ${c} times`);
    }

    for (const s of d.series ?? []) {
      const variant = spec.variants.find((v) => v.indicator === s.indicator && v.seed === s.seed);
      if (!variant) continue; // already reported as unexpected
      const label = `${where}, series ${seriesKey(s)}`;
      if (variant.reference && s.reference !== variant.reference) add(`${label}: reference is "${s.reference}", expected "${variant.reference}"`);
      if (variant.mult !== undefined && s.mult !== variant.mult) add(`${label}: mult is ${s.mult}, expected ${variant.mult}`);
      const declared = INDICATORS[s.indicator].lines.map((l) => l.key);
      if (!same(Object.keys(s.lines ?? {}).sort(), [...declared].sort())) add(`${label}: lines are [${Object.keys(s.lines ?? {})}], expected [${declared}]`);
      for (const key of declared) {
        const values = s.lines?.[key];
        if (!Array.isArray(values)) continue;
        if (values.length !== n) { add(`${label}, line ${key}: ${values.length} values for ${n} candles`); continue; }
        const first = warmup(variant, s.period);
        values.forEach((v, i) => {
          if (i < first && v !== null) add(`${label}, line ${key}: bar ${i} should still be empty`);
          if (i >= first && !(typeof v === 'number' && Number.isFinite(v))) add(`${label}, line ${key}: bar ${i} has no value`);
        });
      }
    }
  }

  const titles = (ref?.rsiEdge ?? []).map((e) => e.title);
  if (!same(titles, spec.rsiEdge)) add(`RSI edge scenarios are [${titles.length}], expected exactly [${spec.rsiEdge.length}] with the listed titles`);
  for (const e of ref?.rsiEdge ?? []) {
    const label = `RSI edge "${e.title}"`;
    const n = e.closes?.length;
    if (!Number.isInteger(e.period) || e.period < 1) add(`${label}: bad period`);
    if (!n || !e.closes.every(Number.isFinite)) add(`${label}: bad closes`);
    if (e.tradingview?.length !== n) add(`${label}: tradingview has ${e.tradingview?.length} values for ${n} closes`);
    (e.tradingview ?? []).forEach((v, i) => {
      if ((i < e.period) !== (v === null)) add(`${label}: tradingview bar ${i} ${v === null ? 'should have' : 'should not have'} a value`);
    });
    if (e.period >= 2) {
      if (e.talib?.length !== n) add(`${label}: talib has ${e.talib?.length} values for ${n} closes`);
      (e.talib ?? []).forEach((v, i) => { if ((v === null) !== (e.tradingview?.[i] === null)) add(`${label}: talib and tradingview disagree on where values start (bar ${i})`); });
    } else if (e.talib !== null) {
      add(`${label}: TA-Lib cannot do a period below 2, talib must be null`);
    }
    const flat = e.flatBars ?? [];
    if (!flat.every((i, k) => Number.isInteger(i) && i >= e.period && i < n && (k === 0 || i > flat[k - 1]))) add(`${label}: flatBars are not a sorted list of bars with values`);
  }
  return problems;
}
