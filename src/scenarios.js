// Data scenarios for the demo app and the tests.
import { generateCandles } from './generator.js';

const base = (count = 60) => generateCandles({ seed: 42, count });
// "normal" and "long" are prefixes of the live feed (same seed), so streaming can continue them.

export const SCENARIOS = {
  normal: () => base(),
  long: () => base(2000),
  negative: () => base().map((c) => ({ ...c, open: c.open - 150, high: c.high - 150, low: c.low - 150, close: c.close - 150 })),
  huge: () => base().map((c) => ({ ...c, open: c.open * 1e9, high: c.high * 1e9, low: c.low * 1e9, close: c.close * 1e9 })),
  overflow: () => base().map((c, i) => (i === 30 ? { ...c, open: 1e15, high: 1e15, low: 1e15, close: 1e15 } : c)),
  nan: () => base().map((c, i) => (i === 30 ? { ...c, close: NaN } : i === 31 ? { ...c, high: null } : c)),
  duplicates: () => { const d = base(); return [...d, { ...d[10] }, { ...d[20] }]; },
  unordered: () => { const d = base(); return [...d.slice(30), ...d.slice(0, 30)]; },
  empty: () => [],
};
