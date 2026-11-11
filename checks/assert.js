// Tiny assertion helpers shared by the in-page checks (no test framework needed).
export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed'); // never an empty message
}

// JSON with sorted keys, so the order of object keys does not matter.
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export function equal(actual, expected, label = '') {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a !== b) throw new Error(`${label ? `${label}: ` : ''}expected ${b.slice(0, 160)}, got ${a.slice(0, 160)}`);
}

export function close(actual, expected, digits = 6, label = '') {
  if (!(Math.abs(actual - expected) <= 10 ** -digits * Math.max(1, Math.abs(expected)))) {
    throw new Error(`${label ? `${label}: ` : ''}expected ${expected}, got ${actual}`);
  }
}

export function throws(fn, pattern) {
  try { fn(); } catch (e) {
    if (pattern && !pattern.test(String(e.message))) throw new Error(`threw "${e.message}", expected ${pattern}`);
    return;
  }
  throw new Error('expected an error, none was thrown');
}
