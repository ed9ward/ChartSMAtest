import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeRSI } from '../../src/indicators.js';
import { refRSI } from './helpers.js';

// Edge cases of RSI, checked against values calculated outside the app:
//   tradingview: Python implementation of TradingView's published RSI code (down == 0 ? 100 : up == 0 ? 0 : ...)
//   talib:       the TA-Lib library itself (needs a period of at least 2)
// Both are in tests/fixtures/talib-reference.json (see scripts/make-reference.py).
const ref = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
const candles = (xs) => xs.map((x, i) => ({ time: i + 1, open: x, high: x, low: x, close: x, volume: 1 }));
const values = (pts) => pts.map((p) => p.value);
// our RSI as an array aligned to the bars (null where there is no value)
const perBar = (xs, period) => {
  const out = Array(xs.length).fill(null);
  for (const p of computeRSI(candles(xs), period)) out[p.time - 1] = p.value;
  return out;
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('the three basic cases (hand-calculated)', () => {
  it('only rising prices: 100 on every bar', () => {
    expect(values(computeRSI(candles([1, 2, 3, 4, 5, 6, 7, 8]), 3))).toEqual([100, 100, 100, 100, 100]);
  });
  it('only falling prices: 0 on every bar', () => {
    expect(values(computeRSI(candles([8, 7, 6, 5, 4, 3, 2, 1]), 3))).toEqual([0, 0, 0, 0, 0]);
  });
  it('a completely flat price: 100, the TradingView convention (TA-Lib says 50, see below)', () => {
    expect(values(computeRSI(candles(Array(10).fill(5)), 3))).toEqual(Array(7).fill(100));
  });
  it('a flat price at any level and with any period gives the same', () => {
    for (const [level, period] of [[0, 2], [-5, 5], [1e9, 14], [0.0001, 1]]) {
      expect(values(computeRSI(candles(Array(30).fill(level)), period)).every((v) => v === 100)).toBe(true);
    }
  });
});

describe('movement that stops (hand-calculated)', () => {
  it('after a zigzag the RSI stays at its last value: both averages decay by the same factor', () => {
    // changes +2 -1 +2 -1 0 0 0 ... with period 3.
    // bar 3: avgGain 4/3, avgLoss 1/3 -> RS 4 -> 80.  bar 4: avgGain 8/9, avgLoss 5/9 -> RS 1.6 -> 100 * 8 / 13.
    const rsi = perBar([1, 3, 2, 4, 3, ...Array(25).fill(3)], 3);
    expect(rsi[3]).toBeCloseTo(80, 12);
    expect(rsi[4]).toBeCloseTo(800 / 13, 12);
    for (let i = 5; i < rsi.length; i++) expect(rsi[i]).toBeCloseTo(800 / 13, 10); // frozen, not drifting to 50 or 100
  });
  it('the same for a falling zigzag', () => {
    const rsi = perBar([6, 4, 5, 3, 4, ...Array(25).fill(4)], 3);
    for (let i = 4; i < rsi.length; i++) expect(rsi[i]).toBeCloseTo(rsi[4], 10);
    expect(rsi[4]).toBeGreaterThan(0);
    expect(rsi[4]).toBeLessThan(50);
  });
  it('after a pure rise the RSI stays 100, after a pure fall it stays 0', () => {
    expect(perBar([1, 2, 3, 4, 5, ...Array(20).fill(5)], 3).slice(3).every((v) => v === 100)).toBe(true);
    expect(perBar([5, 4, 3, 2, 1, ...Array(20).fill(1)], 3).slice(3).every((v) => v === 0)).toBe(true);
  });
  it('the RSI at the stop is the same whatever the length of the quiet that follows', () => {
    const atStop = perBar([1, 3, 2, 4, 3], 3).at(-1);
    for (const quiet of [1, 5, 50, 400]) expect(perBar([1, 3, 2, 4, 3, ...Array(quiet).fill(3)], 3).at(-1)).toBeCloseTo(atStop, 9);
  });
  it('a flat stretch first and then a move: 100 while nothing moved, then the normal value', () => {
    expect(perBar([5, 5, 5, 5, 5, 6, 7], 3)).toEqual([null, null, null, 100, 100, 100, 100]);
    expect(perBar([5, 5, 5, 5, 5, 4, 3], 3)).toEqual([null, null, null, 100, 100, 0, 0]);
  });
  it('a move, a stop and a move the other way: the RSI recovers from the frozen value', () => {
    const rsi = perBar([1, 2, 3, 4, 5, 6, 6, 6, 6, 5, 4, 3], 3);
    expect(rsi[8]).toBe(100);          // frozen at 100 while nothing falls
    expect(rsi[9]).toBeLessThan(100);  // the first fall is noticed at once
    expect(rsi.at(-1)).toBeLessThan(rsi[9]);
  });
  it('period 1: every bar is judged by its own change; a zero change is "nothing moved" -> 100', () => {
    expect(perBar([1, 2, 2, 1, 1, 3], 1)).toEqual([null, 100, 100, 0, 100, 100]);
  });
});

describe('the reference does not hide the convention', () => {
  const flat = candles(Array(10).fill(5));
  it('refuses to give a value for a flat price unless the convention is stated', () => {
    expect(() => refRSI(flat, 3, 'close')).toThrow(/undefined when nothing moved/);
  });
  it('gives what the stated convention says', () => {
    expect(values(refRSI(flat, 3, 'close', { flat: 100 }))).toEqual(Array(7).fill(100));
    expect(values(refRSI(flat, 3, 'close', { flat: 50 }))).toEqual(Array(7).fill(50));
  });
  it('needs no convention where something moved', () => {
    expect(() => refRSI(candles([1, 3, 2, 4, 3, 3, 3, 3, 3]), 3, 'close')).not.toThrow();
  });
});

describe('edge cases against independent values', () => {
  const scenarios = ref.rsiEdge;
  it('the reference file has them all', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    for (const e of scenarios) {
      expect(e.tradingview).toHaveLength(e.closes.length);
      if (e.talib) expect(e.talib).toHaveLength(e.closes.length);
    }
  });

  for (const e of ref.rsiEdge) {
    describe(e.title, () => {
      const ours = perBar(e.closes, e.period);

      it('equals TradingView\'s published rule, bar by bar', () => {
        expect(ours.map((v) => v === null)).toEqual(e.tradingview.map((v) => v === null));
        e.tradingview.forEach((want, i) => { if (want !== null) expect(near(ours[i], want), `bar ${i}: ${ours[i]} vs ${want}`).toBe(true); });
      });

      it('never produces NaN or a value outside 0..100', () => {
        for (const v of ours.filter((x) => x !== null)) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
      });

      if (e.talib) {
        it('equals TA-Lib on every bar except those where nothing moved at all (100 against 50)', () => {
          const differing = [];
          e.talib.forEach((want, i) => {
            if (want === null) { expect(ours[i]).toBeNull(); return; }
            if (!near(ours[i], want, 1e-8)) differing.push(i);
          });
          expect(differing).toEqual(e.flatBars);
          for (const i of differing) {
            expect(ours[i]).toBe(100);
            expect(e.talib[i]).toBe(50);
          }
        });
      } else {
        it('is a case TA-Lib cannot do (it needs a period of at least 2)', () => {
          expect(e.period).toBe(1);
        });
      }
    });
  }

  it('TA-Lib\'s own answer for a flat price is 50, TradingView\'s rule gives 100: the one known difference', () => {
    for (const title of ['flat', 'flat, period 14']) {
      const e = ref.rsiEdge.find((x) => x.title === title);
      expect(e.talib.filter((v) => v !== null).every((v) => v === 50)).toBe(true);
      expect(e.tradingview.filter((v) => v !== null).every((v) => v === 100)).toBe(true);
      expect(e.flatBars).toHaveLength(e.closes.length - e.period);
    }
  });

  it('where something moved, the two agree: rise, fall, rise/fall then flat, and the movement before a stop', () => {
    for (const title of ['only up', 'only down', 'up, then flat', 'down, then flat', 'zigzag up, then flat', 'zigzag down, then flat', 'up, flat, down']) {
      const e = ref.rsiEdge.find((x) => x.title === title);
      expect(e.flatBars, title).toEqual([]);
      e.tradingview.forEach((v, i) => { if (v !== null) expect(near(v, e.talib[i], 1e-8), `${title} bar ${i}`).toBe(true); });
    }
  });

  describe('a long quiet after a move: the averages finally underflow to zero', () => {
    const e = ref.rsiEdge.find((x) => x.title.startsWith('period 2, up, then 1300'));
    const ours = perBar(e.closes, e.period);
    const first = e.flatBars[0];
    it('the RSI stays frozen for a thousand bars, drifts up in the last few before zero, then the flat convention takes over', () => {
      expect(first).toBeGreaterThan(1000);
      const frozen = ours[7];
      expect(frozen).toBe(72);
      // frozen exactly, until the smaller average is down to a few quanta of the smallest representable number
      for (let i = 7; i < first - 7; i++) expect(near(ours[i], frozen, 1e-9), `bar ${i}`).toBe(true);
      // in those last bars the ratio changes (precision is gone), the RSI moves towards 100 and never back
      for (let i = first - 7; i < first; i++) {
        expect(ours[i]).toBeGreaterThanOrEqual(ours[i - 1]);
        expect(ours[i]).toBeLessThanOrEqual(100);
      }
      for (let i = first; i < ours.length; i++) expect(ours[i]).toBe(100);
    });
    it('the flat bars are one unbroken run to the end', () => {
      expect(e.flatBars).toEqual(Array.from({ length: e.closes.length - first }, (_, k) => first + k));
    });
    it('TA-Lib says 50 on exactly those bars and the same as us before', () => {
      for (let i = first; i < e.talib.length; i++) expect(e.talib[i]).toBe(50);
      for (let i = 7; i < first; i++) expect(near(e.talib[i], ours[i], 1e-8)).toBe(true);
    });
  });
});
