// SMA over a chosen price source. Pure functions, no DOM.

export const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];
export const MAX_PERIOD = 2000;

export function sourceValue(candle, source) {
  switch (source) {
    case 'open':
    case 'high':
    case 'low':
    case 'close':
    case 'volume':
      return candle[source];
    case 'hl2':
      return candle.high / 2 + candle.low / 2;
    case 'hlc3':
      return candle.high / 3 + candle.low / 3 + candle.close / 3;
    case 'ohlc4':
      return candle.open / 4 + candle.high / 4 + candle.low / 4 + candle.close / 4;
    default:
      throw new Error(`Unknown SMA source: ${source}`);
  }
}

export function assertPeriod(period) {
  if (!Number.isSafeInteger(period) || period < 1 || period > MAX_PERIOD) {
    throw new RangeError(`SMA period must be an integer between 1 and ${MAX_PERIOD}, got ${period}`);
  }
}

// Rolling-window SMA: O(n) instead of recalculating every window in O(n * period).
// Invalid values invalidate only windows that contain them. If a finite input window
// overflows its sum, recompute it when it becomes eligible again after the bad value leaves.
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
    if (!Number.isFinite(sum)) sum = window.reduce((total, v) => total + v, 0);
    const average = sum / period;
    if (Number.isFinite(average)) out.push({ time: candles[i].time, value: average });
  }
  return out;
}
