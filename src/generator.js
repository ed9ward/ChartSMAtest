// Deterministic candle generator: sine wave + seeded noise.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * @returns {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>}
 * time is a UTC timestamp in seconds.
 */
export function generateCandles({
  seed = 1,
  count = 200,
  startTime = 1700000000,
  interval = 60,
  base = 100,
  amplitude = 20,
  period = 50,
  noise = 1.5,
} = {}) {
  const rnd = mulberry32(seed);
  const price = (i) =>
    base + amplitude * Math.sin((2 * Math.PI * i) / period) + (rnd() - 0.5) * 2 * noise;
  const candles = [];
  let prevClose = price(0);
  for (let i = 0; i < count; i++) {
    const open = round2(prevClose);
    const close = round2(price(i + 1));
    const wick = rnd() * noise;
    const high = round2(Math.max(open, close) + wick);
    const low = round2(Math.min(open, close) - rnd() * noise);
    const volume = Math.round(1000 + rnd() * 9000);
    candles.push({ time: startTime + i * interval, open, high, low, close, volume });
    prevClose = close;
  }
  return candles;
}

/**
 * State of a still-forming candle after `k` of `ticks` ticks.
 * k === ticks gives exactly the final candle.
 */
export function partialCandle(final, k, ticks) {
  const f = Math.min(Math.max(k / ticks, 0), 1);
  const open = final.open;
  const close = round2(open + (final.close - open) * f);
  const top = Math.max(open, close);
  const bottom = Math.min(open, close);
  const finalTop = Math.max(final.open, final.close);
  const finalBottom = Math.min(final.open, final.close);
  return {
    time: final.time,
    open,
    close: f === 1 ? final.close : close,
    high: f === 1 ? final.high : round2(top + (final.high - finalTop) * f),
    low: f === 1 ? final.low : round2(bottom - (finalBottom - final.low) * f),
    volume: Math.round(final.volume * f),
  };
}
