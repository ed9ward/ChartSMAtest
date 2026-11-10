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

// Average of the window ending at `index`; null if the window is incomplete
// or contains a non-finite value (NaN, null, Infinity) or overflows.
export function smaAt(candles, index, period, source) {
  assertPeriod(period);
  if (index < period - 1 || index >= candles.length) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const v = sourceValue(candles[i], source);
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    sum += v;
  }
  const avg = sum / period;
  return Number.isFinite(avg) ? avg : null;
}

// Full SMA series as chart points {time, value}; points with no valid value are skipped.
export function computeSMA(candles, period, source = 'close') {
  assertPeriod(period);
  sourceValue(candles[0] ?? {}, source); // validate source name early
  const out = [];
  for (let i = period - 1; i < candles.length; i++) {
    const value = smaAt(candles, i, period, source);
    if (value !== null) out.push({ time: candles[i].time, value });
  }
  return out;
}
