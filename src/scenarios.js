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
  // 4 impossible candles (high below low, high below close, low above open, negative volume); flat and zero-volume ones are fine
  inconsistent: () => base().map((c, i) => {
    if (i === 10) return { ...c, high: c.low, low: c.high + 1 };
    if (i === 20) return { ...c, high: Math.min(c.open, c.close) - 1 };
    if (i === 30) return { ...c, low: Math.max(c.open, c.close) + 1 };
    if (i === 40) return { ...c, volume: -5 };
    if (i === 50) return { ...c, volume: 0 };
    if (i === 55) return { ...c, open: 100, high: 100, low: 100, close: 100 };
    return c;
  }),
  // nothing moves at all: every price equal, the case where indicator conventions differ (RSI: TradingView 100, TA-Lib 50)
  flat: () => base().map((c) => ({ ...c, open: 100, high: 100, low: 100, close: 100, volume: 10 })),
  // a rising zigzag for 30 bars, then the price stops dead
  stalled: () => base().map((c, i) => {
    const price = 100 + Math.min(i, 30) + (i < 30 && i % 2 === 1 ? -2 : 0);
    return { ...c, open: price, high: price, low: price, close: price, volume: 10 };
  }),
  empty: () => [],
};
