// Validates raw candles before they reach the chart (the chart library throws
// on unordered / duplicate time, so the wrapper has to deal with it).

export const MAX_ABS_PRICE = 1e12;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * The one rule for "is this candle usable", used for history and for live updates alike.
 * Returns null when it is, otherwise why not:
 *   'invalid'      not numbers (NaN, null, strings, missing fields)
 *   'range'        an absurd price
 *   'inconsistent' impossible OHLC (high below open/close/low, low above open/close) or a negative volume
 * Negative prices are allowed (some instruments have them); the OHLC rules still apply to them.
 */
export function validateCandle(c) {
  if (!c || !isNum(c.time) || ![c.open, c.high, c.low, c.close].every(isNum) || !isNum(c.volume)) return 'invalid';
  if ([c.open, c.high, c.low, c.close].some((p) => Math.abs(p) > MAX_ABS_PRICE)) return 'range';
  // high >= max(open, close) and low <= min(open, close) also give high >= low
  if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.volume < 0) return 'inconsistent';
  return null;
}

export function sanitizeCandles(raw, intervalSeconds = null) {
  if (intervalSeconds !== null && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0)) {
    throw new RangeError(`intervalSeconds must be a positive safe integer, got ${intervalSeconds}`);
  }
  const issues = [];
  if (!Array.isArray(raw)) return { candles: [], issues: ['input is not an array'] };

  const byTime = new Map();
  const dropped = { invalid: Number.isSafeInteger(raw.invalidCount) && raw.invalidCount > 0 ? raw.invalidCount : 0, range: 0, inconsistent: 0 };
  let duplicates = 0;
  let unordered = false;
  let prevTime = -Infinity;

  for (const c of raw) {
    const problem = validateCandle(c);
    if (problem) {
      dropped[problem]++;
      continue;
    }
    if (c.time < prevTime) unordered = true;
    prevTime = Math.max(prevTime, c.time);
    if (byTime.has(c.time)) duplicates++;
    byTime.set(c.time, c); // last one wins
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (dropped.invalid) issues.push(`dropped ${dropped.invalid} invalid candle(s)`);
  if (dropped.range) issues.push(`dropped ${dropped.range} out-of-range candle(s)`);
  if (dropped.inconsistent) issues.push(`dropped ${dropped.inconsistent} inconsistent candle(s) (impossible high/low or negative volume)`);
  if (duplicates) issues.push(`merged ${duplicates} duplicate timestamp(s)`);
  if (unordered) issues.push('sorted unordered data');
  if (intervalSeconds !== null && candles.length > 1) {
    let missing = 0;
    for (let i = 1; i < candles.length; i++) {
      const steps = (candles[i].time - candles[i - 1].time) / intervalSeconds;
      if (Number.isSafeInteger(steps) && steps > 1) missing += steps - 1;
    }
    if (missing) issues.push(`source omitted ${missing} candle interval(s); indicators use returned candles only`);
  }
  if (candles.length === 0) issues.push('no data to display');
  return { candles, issues };
}

/**
 * Append a candle while keeping only the newest `limit` entries.
 * Mutates the supplied array and returns true when old entries were removed.
 */
export function appendBoundedCandle(candles, candle, limit) {
  if (!Array.isArray(candles)) throw new TypeError('candles must be an array');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive safe integer');
  candles.push(candle);
  if (candles.length > limit) {
    candles.splice(0, candles.length - limit);
    return true;
  }
  return false;
}
