import { describe, it, expect } from 'vitest';
import { generateCandles, partialCandle } from '../../src/generator.js';

describe('generator', () => {
  it('is deterministic for the same seed and differs for another seed', () => {
    expect(generateCandles({ seed: 7, count: 50 })).toEqual(generateCandles({ seed: 7, count: 50 }));
    expect(generateCandles({ seed: 7, count: 50 })).not.toEqual(generateCandles({ seed: 8, count: 50 }));
  });

  it('produces valid OHLC candles with increasing time', () => {
    const candles = generateCandles({ seed: 3, count: 300 });
    expect(candles).toHaveLength(300);
    candles.forEach((c, i) => {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.volume).toBeGreaterThan(0);
      if (i > 0) expect(c.time).toBeGreaterThan(candles[i - 1].time);
    });
  });

  it('is prefix-stable: a longer run starts with the shorter run', () => {
    expect(generateCandles({ seed: 42, count: 1000 }).slice(0, 60)).toEqual(generateCandles({ seed: 42, count: 60 }));
  });

  it('follows the sine shape: price oscillates around the base', () => {
    const closes = generateCandles({ seed: 1, count: 200, base: 100, amplitude: 20, noise: 0.5 }).map((c) => c.close);
    expect(Math.max(...closes)).toBeGreaterThan(110);
    expect(Math.min(...closes)).toBeLessThan(90);
  });

  it('partialCandle converges to the final candle and stays valid on the way', () => {
    const final = generateCandles({ seed: 5, count: 1 })[0];
    for (let k = 1; k <= 5; k++) {
      const p = partialCandle(final, k, 5);
      expect(p.high).toBeGreaterThanOrEqual(Math.max(p.open, p.close));
      expect(p.low).toBeLessThanOrEqual(Math.min(p.open, p.close));
      expect(p.time).toBe(final.time);
    }
    expect(partialCandle(final, 5, 5)).toEqual(final);
  });
});
