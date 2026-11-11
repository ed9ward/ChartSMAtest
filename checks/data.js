// Candles the chart should hold after `steps` live ticks of the demo feed, started from `start` bars.
import { generateCandles, partialCandle } from '../src/generator.js';
import { TICKS_PER_CANDLE } from '../src/feed.js';

const FULL = generateCandles({ seed: 42, count: 3000 });

export function expectedBars(start, steps) {
  if (steps === 0) return FULL.slice(0, start);
  const bars = FULL.slice(0, start + Math.ceil(steps / TICKS_PER_CANDLE));
  const k = steps % TICKS_PER_CANDLE === 0 ? TICKS_PER_CANDLE : steps % TICKS_PER_CANDLE;
  bars[bars.length - 1] = partialCandle(FULL[bars.length - 1], k, TICKS_PER_CANDLE);
  return bars;
}
