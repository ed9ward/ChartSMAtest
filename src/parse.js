// Strict numeric parsing for untrusted exchange payloads.
// Accept JSON numbers and ordinary decimal strings; reject coercible non-numbers
// such as null, booleans, whitespace-only strings, arrays and objects.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse an exchange epoch timestamp and optionally require candle-bucket alignment. */
export function parseBucketTimestamp(value, unitsPerSecond, intervalSeconds = null) {
  if (!Number.isSafeInteger(unitsPerSecond) || unitsPerSecond <= 0) return null;
  if (intervalSeconds !== null && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0)) return null;
  const raw = parseFiniteNumber(value);
  if (raw === null || !Number.isSafeInteger(raw) || raw < 0) return null;
  if (raw % unitsPerSecond !== 0) return null;
  const seconds = raw / unitsPerSecond;
  if (intervalSeconds !== null && seconds % intervalSeconds !== 0) return null;
  return seconds;
}
