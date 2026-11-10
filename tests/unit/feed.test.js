import { describe, it, expect } from 'vitest';
import { createFeed, TICKS_PER_CANDLE } from '../../src/feed.js';
import { generateCandles } from '../../src/generator.js';

const full = generateCandles({ seed: 42, count: 3000 });

describe('feed', () => {
  it('first tick of a candle is "new", the next ones are updates', () => {
    const feed = createFeed({ startIndex: 0 });
    const flags = Array.from({ length: TICKS_PER_CANDLE * 2 }, () => feed.tick().isNew);
    expect(flags).toEqual([true, false, false, false, false, true, false, false, false, false]);
  });

  it('the last tick of a candle delivers exactly the final candle', () => {
    const feed = createFeed({ startIndex: 60 });
    let last;
    for (let i = 0; i < TICKS_PER_CANDLE; i++) last = feed.tick().candle;
    expect(last).toEqual(full[60]);
  });

  it('continues with the following candles in order, starting at startIndex', () => {
    const feed = createFeed({ startIndex: 10 });
    const finals = [];
    for (let i = 0; i < TICKS_PER_CANDLE * 3; i++) {
      const { candle } = feed.tick();
      if ((i + 1) % TICKS_PER_CANDLE === 0) finals.push(candle);
    }
    expect(finals).toEqual(full.slice(10, 13));
  });

  it('every intermediate candle is valid and keeps its time', () => {
    const feed = createFeed({ startIndex: 0 });
    for (let i = 0; i < TICKS_PER_CANDLE * 20; i++) {
      const { candle: c } = feed.tick();
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.time).toBe(full[Math.floor(i / TICKS_PER_CANDLE)].time);
    }
  });

  it('returns null when the data is exhausted, and keeps returning null', () => {
    const feed = createFeed({ startIndex: 0, total: 2 });
    for (let i = 0; i < TICKS_PER_CANDLE * 2; i++) expect(feed.tick()).not.toBeNull();
    expect(feed.tick()).toBeNull();
    expect(feed.tick()).toBeNull();
  });

  it('a start index past the end gives nothing', () => {
    expect(createFeed({ startIndex: 5, total: 5 }).tick()).toBeNull();
  });
});
