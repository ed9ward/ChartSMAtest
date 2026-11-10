// Independent reference implementations used as the "expected" values by the tests and by the in-page checks.
// Deliberately written differently from src/ (other formulas, no shared code) and only for clean, finite data.
export const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

export function refSource(c, source) {
  const map = {
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    hl2: (c.high + c.low) / 2,
    hlc3: (c.high + c.low + c.close) / 3,
    ohlc4: (c.open + c.high + c.low + c.close) / 4,
  };
  return map[source];
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const xsOf = (candles, source) => candles.map((c) => refSource(c, source));

export function refSMA(candles, period, source) {
  const xs = xsOf(candles, source);
  const out = [];
  for (let end = period; end <= xs.length; end++) {
    out.push({ time: candles[end - 1].time, value: mean(xs.slice(end - period, end)) });
  }
  return out;
}

// EMA written as acc + k * (x - acc); seeded with the mean of the first `period` values.
export function refEMA(candles, period, source) {
  const xs = xsOf(candles, source);
  if (xs.length < period) return [];
  const k = 2 / (period + 1);
  let acc = mean(xs.slice(0, period));
  const out = [{ time: candles[period - 1].time, value: acc }];
  xs.slice(period).forEach((x, i) => {
    acc += k * (x - acc);
    out.push({ time: candles[period + i].time, value: acc });
  });
  return out;
}

// Population standard deviation as sqrt(E[x^2] - E[x]^2).
export function refBB(candles, period, mult, source) {
  const xs = xsOf(candles, source);
  const out = { upper: [], basis: [], lower: [] };
  for (let end = period; end <= xs.length; end++) {
    const w = xs.slice(end - period, end);
    const m = mean(w);
    const sd = Math.sqrt(Math.max(0, mean(w.map((x) => x * x)) - m * m));
    const time = candles[end - 1].time;
    out.upper.push({ time, value: m + mult * sd });
    out.basis.push({ time, value: m });
    out.lower.push({ time, value: m - mult * sd });
  }
  return out;
}

// Wilder RSI: averages updated as avg - avg/period + x/period; RSI = 100 * up / (up + down).
export function refRSI(candles, period, source) {
  const xs = xsOf(candles, source);
  const diffs = xs.slice(1).map((x, i) => x - xs[i]);
  if (diffs.length < period) return [];
  const up = diffs.map((d) => (d > 0 ? d : 0));
  const down = diffs.map((d) => (d < 0 ? -d : 0));
  let avgUp = mean(up.slice(0, period));
  let avgDown = mean(down.slice(0, period));
  const rsi = () => (avgDown === 0 ? 100 : (100 * avgUp) / (avgUp + avgDown));
  const out = [{ time: candles[period].time, value: rsi() }];
  for (let j = period; j < diffs.length; j++) {
    avgUp += (up[j] - avgUp) / period;
    avgDown += (down[j] - avgDown) / period;
    out.push({ time: candles[j + 1].time, value: rsi() });
  }
  return out;
}

// Throws a readable error when two series differ (relative tolerance 1e-6 by default).
export function compareSeries(actual, expected, digits = 6) {
  if (actual.length !== expected.length) {
    throw new Error(`length mismatch: got ${actual.length}, expected ${expected.length}`);
  }
  actual.forEach((p, i) => {
    if (p.time !== expected[i].time) throw new Error(`time mismatch at ${i}: ${p.time} vs ${expected[i].time}`);
    const tol = Math.max(1, Math.abs(expected[i].value)) * 10 ** -digits;
    if (!(Math.abs(p.value - expected[i].value) <= tol)) {
      throw new Error(`value mismatch at ${i}: got ${p.value}, expected ${expected[i].value}`);
    }
  });
}
