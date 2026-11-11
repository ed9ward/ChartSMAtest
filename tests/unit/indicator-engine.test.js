import { describe, it, expect } from 'vitest';
import { createIndicatorEngine } from '../../src/indicator-engine.js';
import { computeIndicator } from '../../src/indicators.js';
import { SOURCES } from '../../src/sma.js';
import { generateCandles } from '../../src/generator.js';

const paramsFor = (kind) => ({
  sma: { period: 20 },
  ema: { period: 20, start: 'first' },
  bb: { period: 20, mult: 2 },
  rsi: { period: 14 },
})[kind];

function expectSame(actual, expected) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const key of Object.keys(expected)) {
    expect(actual[key].map((point) => point.time)).toEqual(expected[key].map((point) => point.time));
    actual[key].forEach((point, index) => {
      const expectedValue = expected[key][index].value;
      const tolerance = 1e-10 * Math.max(Math.abs(point.value), Math.abs(expectedValue), 1e-300);
      expect(Math.abs(point.value - expectedValue)).toBeLessThanOrEqual(tolerance);
    });
  }
}

function nextCandle(previous, offset, adjustment = 0) {
  const open = previous.close + adjustment;
  const close = open + 0.75;
  return {
    time: previous.time + 60 * offset,
    open,
    high: close + 0.5,
    low: open - 0.5,
    close,
    volume: previous.volume + 0.25,
  };
}

describe('createIndicatorEngine', () => {
  for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
    for (const source of SOURCES) {
      const starts = kind === 'ema' ? ['first', 'sma'] : [undefined];
      for (const start of starts) {
        it(`${kind} / ${source} / ${start ?? 'default'}: append and replace the forming candle matches the pure reference`, () => {
          const initial = generateCandles({ seed: 71, count: 80 });
          const params = { ...paramsFor(kind), ...(start ? { start } : {}) };
          const engine = createIndicatorEngine(kind, initial, params, source);

          const appended = nextCandle(initial.at(-1), 1);
          engine.upsert(appended);
          expectSame(engine.data(), computeIndicator(kind, [...initial, appended], params, source));

          // Repeated updates to one forming candle must replace its prior contribution, not compound it.
          const revised = nextCandle(initial.at(-1), 1, 2.5);
          engine.upsert(revised);
          expectSame(engine.data(), computeIndicator(kind, [...initial, revised], params, source));

          const following = nextCandle(revised, 1, -1.25);
          engine.upsert(following);
          expectSame(engine.data(), computeIndicator(kind, [...initial, revised, following], params, source));
        });
      }
    }
  }

  it('replacing the newest candle several times does not double-count EMA or RSI state', () => {
    const initial = generateCandles({ seed: 9, count: 40 });
    for (const kind of ['ema', 'rsi']) {
      const params = paramsFor(kind);
      const engine = createIndicatorEngine(kind, initial, params, 'close');
      for (const adjustment of [1, -2, 3, -1, 0.5]) {
        const changed = nextCandle(initial.at(-1), 1, adjustment);
        engine.upsert(changed);
        expectSame(engine.data(), computeIndicator(kind, [...initial, changed], params, 'close'));
      }
    }
  });

  it('replacing an invalid forming candle restores the prior state for every indicator', () => {
    const initial = generateCandles({ seed: 23, count: 45 });
    for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
      const params = paramsFor(kind);
      const engine = createIndicatorEngine(kind, initial, params, 'close');
      const invalid = { ...nextCandle(initial.at(-1), 1), close: NaN };
      engine.upsert(invalid);
      expectSame(engine.data(), computeIndicator(kind, [...initial, invalid], params, 'close'));

      const repaired = nextCandle(initial.at(-1), 1, 3);
      engine.upsert(repaired);
      expectSame(engine.data(), computeIndicator(kind, [...initial, repaired], params, 'close'));

      const following = nextCandle(repaired, 1, -0.5);
      engine.upsert(following);
      expectSame(engine.data(), computeIndicator(kind, [...initial, repaired, following], params, 'close'));
    }
  });
  it('rejects an out-of-order candle; historical corrections require a rebuild', () => {
    const initial = generateCandles({ seed: 4, count: 20 });
    const engine = createIndicatorEngine('sma', initial, { period: 5 }, 'close');
    expect(() => engine.upsert({ ...initial[0], close: initial[0].close + 1 })).toThrow(/historical corrections/);
  });

  it('matches pure calculations across invalid source values and sparse timestamps', () => {
    const candles = generateCandles({ seed: 14, count: 60 });
    candles[12].close = NaN;
    for (let i = 35; i < candles.length; i++) candles[i].time += 180;
    for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
      const params = paramsFor(kind);
      const engine = createIndicatorEngine(kind, candles, params, 'close');
      expectSame(engine.data(), computeIndicator(kind, candles, params, 'close'));
    }
  });

  it('matches the pure reference on long randomized histories with gaps and invalid inputs', () => {
    for (const seed of [3, 17, 91]) {
      let state = seed;
      const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
      let time = 1_800_000_000;
      const candles = Array.from({ length: 1200 }, (_, i) => {
        time += random() < 0.04 ? 300 : 60;
        const close = 50 + random() * 1000;
        const open = close + (random() - 0.5) * 10;
        const candle = { time, open, high: Math.max(open, close) + random() * 5,
          low: Math.min(open, close) - random() * 5, close, volume: random() * 100 };
        if (i % 173 === 0) candle.close = NaN;
        return candle;
      });
      for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
        for (const source of SOURCES) {
          const params = { ...paramsFor(kind), period: kind === 'rsi' ? 9 : 13,
            ...(kind === 'ema' ? { start: seed % 2 ? 'first' : 'sma' } : {}) };
          const engine = createIndicatorEngine(kind, candles, params, source);
          expectSame(engine.data(), computeIndicator(kind, candles, params, source));
          const previous = candles.at(-1);
          for (const adjustment of [-3, 0.5, 2, -1]) {
            const revised = { ...previous, close: previous.close + adjustment,
              high: previous.high + Math.max(0, adjustment), low: previous.low + Math.min(0, adjustment) };
            engine.upsert(revised);
            expectSame(engine.data(), computeIndicator(kind, [...candles.slice(0, -1), revised], params, source));
          }
        }
      }
    }
  }, 15_000);

  it('rebuilding after a historical correction matches the pure reference', () => {
    const candles = generateCandles({ seed: 101, count: 500 });
    const corrected = candles.map((candle) => ({ ...candle }));
    corrected[211] = { ...corrected[211], close: corrected[211].close + 17, high: corrected[211].high + 17 };
    for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
      const rebuilt = createIndicatorEngine(kind, corrected, paramsFor(kind), 'close');
      expectSame(rebuilt.data(), computeIndicator(kind, corrected, paramsFor(kind), 'close'));
    }
  });

  it('keeps tiny and very large finite price scales numerically stable', () => {
    for (const scale of [1e-200, 1e200]) {
      const candles = Array.from({ length: 40 }, (_, i) => {
        const close = scale * (1 + i / 100);
        return { time: i * 60, open: close, high: close * 1.01, low: close * 0.99, close, volume: scale };
      });
      for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
        const params = { ...paramsFor(kind), period: 5, ...(kind === 'ema' ? { start: 'sma' } : {}) };
        const engine = createIndicatorEngine(kind, candles, params, 'close');
        expectSame(engine.data(), computeIndicator(kind, candles, params, 'close'));
        for (const points of Object.values(engine.data())) for (const point of points) expect(Number.isFinite(point.value)).toBe(true);
      }
    }
  });

  it('rejects unknown indicator sources', () => {
    expect(SOURCES).toContain('close');
    expect(() => createIndicatorEngine('sma', [], { period: 5 }, 'vwap')).toThrow(/Unknown source/);
  });
});
