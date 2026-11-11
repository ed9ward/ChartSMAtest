// Stateful incremental indicator calculation for the live chart.
// The pure computeIndicator() functions remain the reference implementation.
// Only the newest candle is mutable; replacing it restores the state from before that candle.

import { computeIndicator, validateParams } from './indicators.js';
import { SOURCES, sourceValue } from './sma.js';
import { mean, populationStdDev } from './statistics.js';

const emptyState = (kind) => {
  if (kind === 'sma') return { window: [] };
  if (kind === 'ema') return { ema: null, seeded: 0, seedMean: 0 };
  if (kind === 'bb') return { window: [] };
  if (kind === 'rsi') return { previous: null, changes: 0, sumGain: 0, sumLoss: 0, avgGain: null, avgLoss: null };
  throw new Error(`Unknown indicator: ${kind}`);
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function calculate(kind, previous, candle, params, source) {
  const value = sourceValue(candle, source);
  const input = finite(value) ? value : null;
  const { period, mult, start = 'first' } = params;

  if (kind === 'sma') {
    const window = [...previous.window, input].slice(-period);
    if (window.length !== period || window.some((v) => v === null)) return { state: { window }, points: {} };
    const average = mean(window);
    return { state: { window }, points: finite(average) ? { sma: { time: candle.time, value: average } } : {} };
  }

  if (kind === 'ema') {
    if (input === null) return { state: emptyState(kind), points: {} };
    let { ema, seeded, seedMean } = previous;
    const alpha = 2 / (period + 1);
    if (ema !== null) {
      ema = alpha * input + (1 - alpha) * ema;
    } else if (start === 'first') {
      ema = input;
    } else {
      seedMean += (input - seedMean) / (seeded + 1);
      if (++seeded < period) return { state: { ema: null, seeded, seedMean }, points: {} };
      ema = seedMean;
    }
    if (!finite(ema)) return { state: emptyState(kind), points: {} };
    return { state: { ema, seeded, seedMean }, points: { ema: { time: candle.time, value: ema } } };
  }

  if (kind === 'bb') {
    const window = [...previous.window, input].slice(-period);
    if (window.length !== period || window.some((v) => v === null)) return { state: { window }, points: {} };
    const basis = mean(window);
    const deviation = populationStdDev(window);
    const upper = basis + mult * deviation;
    const lower = basis - mult * deviation;
    if (![basis, deviation, upper, lower].every(finite)) return { state: { window }, points: {} };
    return {
      state: { window },
      points: {
        upper: { time: candle.time, value: upper },
        basis: { time: candle.time, value: basis },
        lower: { time: candle.time, value: lower },
      },
    };
  }

  if (kind === 'rsi') {
    if (input === null) return { state: emptyState(kind), points: {} };
    let { previous: previousValue, changes, sumGain, sumLoss, avgGain, avgLoss } = previous;
    if (previousValue === null) {
      return { state: { ...previous, previous: input }, points: {} };
    }
    const change = input - previousValue;
    previousValue = input;
    if (!Number.isFinite(change)) return { state: { ...emptyState(kind), previous: input }, points: {} };
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (avgGain === null) {
      const nextChanges = changes + 1;
      sumGain += (gain - sumGain) / nextChanges;
      sumLoss += (loss - sumLoss) / nextChanges;
      if (++changes < period) {
        return { state: { previous: previousValue, changes, sumGain, sumLoss, avgGain, avgLoss }, points: {} };
      }
      avgGain = sumGain;
      avgLoss = sumLoss;
    } else {
      avgGain = avgGain * ((period - 1) / period) + gain / period;
      avgLoss = avgLoss * ((period - 1) / period) + loss / period;
    }
    const rsi = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
    if (!finite(rsi)) return { state: emptyState(kind), points: {} };
    return {
      state: { previous: previousValue, changes, sumGain, sumLoss, avgGain, avgLoss },
      points: { rsi: { time: candle.time, value: rsi } },
    };
  }

  throw new Error(`Unknown indicator: ${kind}`);
}

/**
 * Create an indicator calculator for an ordered candle series.
 * append/upsert work in O(period) for SMA/BB and O(1) for EMA/RSI.
 * Calling upsert with the current last timestamp replaces that bar without
 * accidentally applying its previous partial value twice to recursive state.
 */
export function createIndicatorEngine(kind, candles, params, source = 'close') {
  validateParams(kind, params);
  if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
  const keys = Object.keys(computeIndicator(kind, [], params, source));
  const data = Object.fromEntries(keys.map((key) => [key, []]));
  const initial = emptyState(kind);
  let currentState = initial;
  let stateBeforeLast = initial;
  let lastTime = null;

  const removeLastPointAt = (time) => {
    for (const key of keys) {
      const last = data[key].at(-1);
      if (last?.time === time) data[key].pop();
    }
  };

  const apply = (candle) => {
    const result = calculate(kind, currentState, candle, params, source);
    currentState = result.state;
    for (const [key, point] of Object.entries(result.points)) data[key].push(point);
    lastTime = candle.time;
    return result.points;
  };

  const upsert = (candle) => {
    if (!candle || !finite(candle.time)) throw new TypeError('candle time must be finite');
    if (lastTime !== null && candle.time < lastTime) {
      throw new RangeError('indicator engine only accepts the newest candle; rebuild for historical corrections');
    }
    if (lastTime === candle.time) {
      removeLastPointAt(candle.time);
      currentState = stateBeforeLast;
    } else {
      stateBeforeLast = currentState;
    }
    return apply(candle);
  };

  for (const candle of candles) upsert(candle);

  return {
    upsert,
    data: () => data,
    latest: () => Object.fromEntries(keys.map((key) => [key, data[key].at(-1) ?? null])),
    lastTime: () => lastTime,
  };
}
