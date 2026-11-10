// Independent reference implementation used as the "expected" value in tests.
// Deliberately written differently from src/sma.js (slice + reduce, no shared code).
export function refSource(c, source) {
  const map = {
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    hl2: (c.high + c.low) / 2,
    hlc3: (c.high + c.low + c.close) / 3,
    ohlc4: (c.open + c.high + c.low + c.close) / 4,
  };
  return map[source];
}

export function refSMA(candles, period, source) {
  const values = candles.map((c) => refSource(c, source));
  const out = [];
  for (let end = period; end <= values.length; end++) {
    const window = values.slice(end - period, end);
    out.push({ time: candles[end - 1].time, value: window.reduce((a, b) => a + b, 0) / period });
  }
  return out;
}

export function expectSeriesClose(actual, expected, digits = 6) {
  if (actual.length !== expected.length) {
    throw new Error(`length mismatch: got ${actual.length}, expected ${expected.length}`);
  }
  actual.forEach((p, i) => {
    if (p.time !== expected[i].time) throw new Error(`time mismatch at ${i}: ${p.time} vs ${expected[i].time}`);
    const tol = Math.max(1, Math.abs(expected[i].value)) * 10 ** -digits;
    if (Math.abs(p.value - expected[i].value) > tol) {
      throw new Error(`value mismatch at ${i}: got ${p.value}, expected ${expected[i].value}`);
    }
  });
}
