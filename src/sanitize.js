// Validates raw candles before they reach the chart (the chart library throws
// on unordered / duplicate time, so the wrapper has to deal with it).

export const MAX_ABS_PRICE = 1e12;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function sanitizeCandles(raw) {
  const issues = [];
  if (!Array.isArray(raw)) return { candles: [], issues: ['input is not an array'] };

  const byTime = new Map();
  let invalid = 0;
  let outOfRange = 0;
  let duplicates = 0;
  let unordered = false;
  let prevTime = -Infinity;

  for (const c of raw) {
    if (!c || !isNum(c.time) || ![c.open, c.high, c.low, c.close].every(isNum) || !isNum(c.volume)) {
      invalid++;
      continue;
    }
    if ([c.open, c.high, c.low, c.close].some((p) => Math.abs(p) > MAX_ABS_PRICE)) {
      outOfRange++;
      continue;
    }
    if (c.time < prevTime) unordered = true;
    prevTime = Math.max(prevTime, c.time);
    if (byTime.has(c.time)) duplicates++;
    byTime.set(c.time, c); // last one wins
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (invalid) issues.push(`dropped ${invalid} invalid candle(s)`);
  if (outOfRange) issues.push(`dropped ${outOfRange} out-of-range candle(s)`);
  if (duplicates) issues.push(`merged ${duplicates} duplicate timestamp(s)`);
  if (unordered) issues.push('sorted unordered data');
  if (candles.length === 0) issues.push('no data to display');
  return { candles, issues };
}
