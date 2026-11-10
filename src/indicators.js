// Indicators over a chosen price source. Pure functions, no DOM.
// Formulas follow TradingView's ta.* functions so values can be compared with its charts.
import { SOURCES, sourceValue, assertPeriod, computeSMA } from './sma.js';

function assertSource(source) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
}

export function assertMultiplier(mult) {
  if (typeof mult !== 'number' || !Number.isFinite(mult) || mult < 0) {
    throw new RangeError(`Multiplier must be a number >= 0, got ${mult}`);
  }
}

// Source values; null where the value is not a finite number.
function values(candles, source) {
  return candles.map((c) => {
    const v = sourceValue(c, source);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  });
}

export const EMA_STARTS = ['first', 'sma'];

function assertEmaStart(start) {
  if (!EMA_STARTS.includes(start)) throw new RangeError(`Unknown EMA start: ${start}`);
}

/**
 * EMA with alpha = 2 / (period + 1): ema = alpha * x + (1 - alpha) * previous. The only thing the platforms disagree
 * about is where the recursion starts, and it matters for a long time when the history is short:
 *
 *   'first' (default)  the first value of the series. This is the reference implementation in the TradingView Pine
 *                      documentation (`sum := na(sum[1]) ? src : ...`) and what pandas ewm(adjust=False) does.
 *                      There is a value on every bar.
 *   'sma'              the average of the first `period` values (TA-Lib). The first value appears on bar `period`.
 *
 * The two differ only by a term that shrinks by (1 - alpha) on every bar. A bad value (NaN, null, Infinity) ends the
 * chain: the next good value starts it again.
 */
export function computeEMA(candles, period, source = 'close', start = 'first') {
  assertPeriod(period);
  assertSource(source);
  assertEmaStart(start);
  const v = values(candles, source);
  const alpha = 2 / (period + 1);
  const out = [];
  let ema = null;
  let seeded = 0;
  let seedSum = 0;
  const reset = () => { ema = null; seeded = 0; seedSum = 0; };
  for (let i = 0; i < v.length; i++) {
    if (v[i] === null) { reset(); continue; }
    if (ema !== null) {
      ema = alpha * v[i] + (1 - alpha) * ema;
    } else if (start === 'first') {
      ema = v[i];
    } else {
      seedSum += v[i];
      if (++seeded < period) continue;
      ema = seedSum / period;
    }
    if (!Number.isFinite(ema)) { reset(); continue; } // rounding at the very edge of the number range
    out.push({ time: candles[i].time, value: ema });
  }
  return out;
}

/** Bollinger Bands: SMA(period) +/- mult * population standard deviation. */
export function computeBB(candles, period, mult = 2, source = 'close') {
  assertPeriod(period);
  assertMultiplier(mult);
  assertSource(source);
  const v = values(candles, source);
  const out = { upper: [], basis: [], lower: [] };
  for (let end = period - 1; end < v.length; end++) {
    const window = v.slice(end - period + 1, end + 1);
    if (window.includes(null)) continue;
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    const upper = mean + mult * sd;
    const lower = mean - mult * sd;
    if (![mean, upper, lower].every(Number.isFinite)) continue;
    const time = candles[end].time;
    out.upper.push({ time, value: upper });
    out.basis.push({ time, value: mean });
    out.lower.push({ time, value: lower });
  }
  return out;
}

/**
 * RSI with Wilder smoothing. The first value needs `period` price changes, so it appears at bar index `period`.
 * No losses -> 100, no gains -> 0 (TradingView's rule). A bad value ends the chain.
 */
export function computeRSI(candles, period, source = 'close') {
  assertPeriod(period);
  assertSource(source);
  const v = values(candles, source);
  const out = [];
  let prev = null;
  let changes = 0;
  let sumGain = 0;
  let sumLoss = 0;
  let avgGain = null;
  let avgLoss = null;
  const reset = () => { prev = null; changes = 0; sumGain = 0; sumLoss = 0; avgGain = null; avgLoss = null; };
  for (let i = 0; i < v.length; i++) {
    if (v[i] === null) { reset(); continue; }
    if (prev === null) { prev = v[i]; continue; }
    const change = v[i] - prev;
    prev = v[i];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (avgGain === null) {
      sumGain += gain;
      sumLoss += loss;
      if (++changes < period) continue;
      avgGain = sumGain / period;
      avgLoss = sumLoss / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rsi = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
    if (!Number.isFinite(rsi)) { reset(); continue; }
    out.push({ time: candles[i].time, value: rsi });
  }
  return out;
}

// What the UI needs to know about each indicator.
export const INDICATORS = {
  sma: {
    label: 'SMA', defaults: { period: 20 },
    lines: [{ key: 'sma', color: '#FF9800', primary: true }],
    compute: (c, p, s) => ({ sma: computeSMA(c, p.period, s) }),
  },
  ema: {
    label: 'EMA', defaults: { period: 20, start: 'first' },
    lines: [{ key: 'ema', color: '#2962FF', primary: true }],
    compute: (c, p, s) => ({ ema: computeEMA(c, p.period, s, p.start) }),
  },
  bb: {
    label: 'BB', defaults: { period: 20, mult: 2 },
    lines: [
      { key: 'basis', color: '#FF9800', primary: true },
      { key: 'upper', color: '#9C27B0' },
      { key: 'lower', color: '#3F51B5' },
    ],
    compute: (c, p, s) => computeBB(c, p.period, p.mult, s),
  },
  rsi: {
    label: 'RSI', defaults: { period: 14 }, pane: 1,
    lines: [{ key: 'rsi', color: '#E91E63', primary: true }],
    compute: (c, p, s) => ({ rsi: computeRSI(c, p.period, s) }),
  },
};

export function validateParams(kind, params) {
  assertPeriod(params.period);
  if (kind === 'bb') assertMultiplier(params.mult);
  if (kind === 'ema' && params.start !== undefined) assertEmaStart(params.start);
}

/** @returns {Record<string, Array<{time:number, value:number}>>} one point list per line of the indicator */
export function computeIndicator(kind, candles, params, source = 'close') {
  const def = INDICATORS[kind];
  if (!def) throw new Error(`Unknown indicator: ${kind}`);
  validateParams(kind, params);
  return def.compute(candles, params, source);
}
