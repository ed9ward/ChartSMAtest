// SMA over a chosen price source. Pure functions, no DOM.

export const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

export function sourceValue(candle, source) {
  switch (source) {
    case 'open':
    case 'high':
    case 'low':
    case 'close':
    case 'volume':
      return candle[source];
    case 'hl2':
      return (candle.high + candle.low) / 2;
    case 'hlc3':
      return (candle.high + candle.low + candle.close) / 3;
    case 'ohlc4':
      return (candle.open + candle.high + candle.low + candle.close) / 4;
    default:
      throw new Error(`Unknown SMA source: ${source}`);
  }
}

export function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`SMA period must be an integer >= 1, got ${period}`);
  }
}

// Full SMA series as chart points {time, value}; a window with a non-finite value
// (NaN, null, Infinity) or an overflowing sum produces no point.
export function computeSMA(candles, period, source = 'close') {
  assertPeriod(period);
  sourceValue(candles[0] ?? {}, source); // validate source name early
  const out = [];
  const window = new Array(period);
  let sum = 0;
  let invalid = 0;
  for (let i = 0; i < candles.length; i++) {
    const slot = i % period;
    if (i >= period) {
      const previous = window[slot];
      if (previous === null) invalid--;
      else sum -= previous;
    }
    const value = sourceValue(candles[i], source);
    window[slot] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (window[slot] === null) invalid++;
    else sum += window[slot];

    if (i < period - 1 || invalid > 0) continue;
    // Recover after overflow or catastrophic cancellation once the offending value leaves the window.
    if (!Number.isFinite(sum)) {
      sum = window.reduce((total, v) => total + v, 0);
    }
    const average = sum / period;
    if (Number.isFinite(average)) out.push({ time: candles[i].time, value: average });
  }
  return out;
}
/ SMA over a chosen price source. Pure functions, no DOM.

export const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

export function sourceValue(candle, source) {
  switch (source) {
    case 'open':
    case 'high':
    case 'low':
    case 'close':
    case 'volume':
      return candle[source];
    case 'hl2':
      return (candle.high + candle.low) / 2;
    case 'hlc3':
      return (candle.high + candle.low + candle.close) / 3;
    case 'ohlc4':
      return (candle.open + candle.high + candle.low + candle.close) / 4;
    default:
      throw new Error(`Unknown SMA source: ${source}`);
  }
}

export function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`SMA period must be an integer >= 1, got ${period}`);
  }
}

// Full SMA series as chart points {time, value}; a window with a non-finite value
// (NaN, null, Infinity) or an overflowing sum produces no point.
export function computeSMA(candles, period, source = 'close') {
  assertPeriod(period);
  sourceValue(candles[0] ?? {}, source); // validate source name early
  const out = [];
  for (let end = period - 1; end < candles.length; end++) {
    let sum = 0;
    let valid = true;
    for (let i = end - period + 1; i <= end && valid; i++) {
      const v = sourceValue(candles[i], source);
      if (typeof v !== 'number' || !Number.isFinite(v)) valid = false;
      else sum += v;
    }
    const value = sum / period;
    if (valid && Number.isFinite(value)) out.push({ time: candles[end].time, value });
  }
  return out;
}
