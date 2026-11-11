// Replays a pre-generated candle sequence tick by tick, like a live data feed.
import { generateCandles, partialCandle } from './generator.js';

export const TICKS_PER_CANDLE = 5;

/**
 * @param {number} startIndex index of the first candle the feed will deliver
 * @returns {{ tick(): ({candle: object, isNew: boolean} | null) }}
 *   tick() returns null when the sequence is exhausted.
 */
export function createFeed({ startIndex = 0, seed = 42, total = 3000, ticksPerCandle = TICKS_PER_CANDLE } = {}) {
  const full = generateCandles({ seed, count: total });
  let index = startIndex;
  let k = 0;
  return {
    tick() {
      if (index >= full.length) return null;
      k++;
      const candle = partialCandle(full[index], k, ticksPerCandle);
      const isNew = k === 1;
      if (k === ticksPerCandle) { index++; k = 0; }
      return { candle, isNew };
    },
  };
}
