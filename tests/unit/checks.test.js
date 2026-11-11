import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGroups } from '../../checks/definitions.js';
import { runChecks, describeError } from '../../checks/runner.js';
import { assert } from '../../checks/assert.js';
import { createUiDriver } from '../../checks/ui.js';
import { parseKline } from '../../src/live.js';

const rows = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const talib = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
const ctx = { realRows: async () => rows, realCandles: async () => rows.map((row) => parseKline(row)), talibReference: async () => talib };

describe('the in-page check suite (everything that does not need a browser)', () => {
  it('has the expected groups', () => {
    expect(buildGroups(ctx).map((g) => g.id)).toEqual(['sma', 'ema', 'bb', 'rsi', 'talib', 'data', 'binance', 'coinbase']);
  });

  it('all checks pass and each group reports its time', async () => {
    const events = [];
    const summary = await runChecks(buildGroups(ctx), { include: (c) => !c.ui, onCheck: (e) => events.push(e.index) });
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(summary.passed);
    expect(summary.total).toBeGreaterThan(180);
    expect(events).toEqual(Array.from({ length: summary.total }, (_, i) => i + 1));
    for (const g of summary.groups) expect(g.ms).toBeGreaterThanOrEqual(0);
  });

  it('the real-data checks really compare: tampered candles make them fail for every indicator', async () => {
    const tampered = rows.map((row) => parseKline(row)).map((c, i) => { const d = (i % 3) * 37; return { ...c, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d }; }); // RSI ignores a constant shift, so shift bars differently
    const summary = await runChecks(buildGroups({ ...ctx, realCandles: async () => tampered }), { include: (c) => !c.ui });
    const failedByGroup = Object.fromEntries(summary.groups.map((g) => [g.id, g.failed]));
    for (const id of ['sma', 'ema', 'bb', 'rsi']) expect(failedByGroup[id], id).toBe(1); // only the golden check
    const failed = summary.results.filter((r) => !r.ok);
    expect(failed.every((r) => /real BTCUSDT data/.test(r.name))).toBe(true);
    expect(failedByGroup.data + failedByGroup.binance).toBe(0);
  });

  it('the RSI edge-case checks really compare: a changed expected value or a changed convention makes them fail', async () => {
    const tamper = (mutate) => {
      const copy = JSON.parse(JSON.stringify(talib));
      mutate(copy.rsiEdge);
      return runChecks(buildGroups({ ...ctx, talibReference: async () => copy }), { include: (c) => !c.ui && /edge cases/.test(c.name) });
    };
    const clean = await runChecks(buildGroups(ctx), { include: (c) => !c.ui && /edge cases/.test(c.name) });
    expect(clean.total).toBe(2);
    expect(clean.failed).toBe(0);

    // TradingView's value for one bar changed
    const a = await tamper((edge) => { const e = edge.find((x) => x.title === 'only up'); e.tradingview[e.tradingview.findIndex((v) => v !== null)] = 99; });
    expect(a.results.map((r) => r.ok)).toEqual([false, true]);

    // TA-Lib says 100 instead of 50 on a flat bar: then ours would "equal" TA-Lib there, which is not the known difference
    const b = await tamper((edge) => { const e = edge.find((x) => x.title === 'flat'); e.talib[e.talib.findIndex((v) => v !== null)] = 100; });
    expect(b.results.map((r) => r.ok)).toEqual([true, false]);

    // an unexpected extra difference from TA-Lib on a bar that is not a flat one
    const c = await tamper((edge) => { const e = edge.find((x) => x.title === 'zigzag up, then flat'); e.talib[e.talib.length - 1] += 1; });
    expect(c.results.map((r) => r.ok)).toEqual([true, false]);
  });

  it('a series missing from the reference file fails the completeness check and the comparison it belongs to, although the rest compares fine', async () => {
    const copy = JSON.parse(JSON.stringify(talib));
    const removed = copy.datasets[0].series.splice(3, 1)[0]; // a Bollinger series of the first dataset
    expect(removed.indicator).toBe('bb');
    const summary = await runChecks(buildGroups({ ...ctx, talibReference: async () => copy }), { include: (c) => !c.ui && /reference file is complete|equals the reference library/.test(c.name) });
    const failed = summary.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.name).sort()).toEqual([
      'Bollinger Bands on real50 equals the reference library',
      'the reference file is complete: exactly the expected series, lines, values and scenarios',
    ]);
    expect(failed.find((r) => /Bollinger/.test(r.name)).error).toMatch(/problem/);
    expect(failed.find((r) => /Bollinger/.test(r.name)).detail.stats.compared).toBeGreaterThan(500); // the numbers are still shown
  });

  it('a series that appears twice or one nobody asked for is found too', async () => {
    for (const mutate of [
      (c) => c.datasets[1].series.push(JSON.parse(JSON.stringify(c.datasets[1].series[0]))),
      (c) => c.datasets[1].series.push({ ...JSON.parse(JSON.stringify(c.datasets[1].series[0])), period: 21 }),
    ]) {
      const copy = JSON.parse(JSON.stringify(talib));
      mutate(copy);
      const summary = await runChecks(buildGroups({ ...ctx, talibReference: async () => copy }), { include: (c) => !c.ui && /reference file is complete|equals the reference library/.test(c.name) });
      expect(summary.results.filter((r) => !r.ok).map((r) => r.name)).toContain('the reference file is complete: exactly the expected series, lines, values and scenarios');
      expect(summary.failed).toBeGreaterThanOrEqual(2);
    }
  });

  it('the runner reports a failing check with its message and keeps going', async () => {
    const groups = [{ id: 'x', title: 'X', checks: [
      { name: 'bad', run: () => { throw new Error('boom'); } },
      { name: 'async bad', run: async () => { throw new Error('later'); } },
      { name: 'good', run: () => {} },
    ] }];
    const s = await runChecks(groups);
    expect(s).toMatchObject({ total: 3, passed: 1, failed: 2 });
    expect(s.results.map((r) => r.error)).toEqual(['boom', 'later', null]);
    expect(s.groups[0]).toMatchObject({ failed: 2, passed: 1 });
  });

  describe('a check that throws is a failure, whatever the thrown value looks like', () => {
    class Quiet extends Error {}
    const thrown = {
      "new Error('')": () => { throw new Error(''); },
      "throw ''": () => { throw ''; },
      "new Error('   ') (only spaces)": () => { throw new Error('   '); },
      "throw '   '": () => { throw '   '; },
      'an Error subclass with no message': () => { throw new Quiet(); },
      "a TypeError with an empty message": () => { throw new TypeError(''); },
      'throw undefined': () => { throw undefined; },
      'throw null': () => { throw null; },
      'throw 0': () => { throw 0; },
      'throw false': () => { throw false; },
      'throw NaN': () => { throw NaN; },
      'throw {} (no text)': () => { throw {}; },
      'throw []': () => { throw []; },
      'throw an object whose text is empty': () => { throw { toString: () => '' }; },
      'throw an object whose toString throws': () => { throw { toString() { throw new Error('no'); } }; },
      'a symbol': () => { throw Symbol('s'); },
      "an async function throwing new Error('')": async () => { throw new Error(''); },
      "an async function throwing ''": async () => { throw ''; },
      'a promise rejected with undefined': () => Promise.reject(undefined),
      "a promise rejected with ''": () => Promise.reject(''),
      "an assertion with an empty message": () => assert(false, ''),
      'an assertion without a message': () => assert(false),
    };
    for (const [name, run] of Object.entries(thrown)) {
      it(`${name}`, async () => {
        const s = await runChecks([{ id: 'x', title: 'X', checks: [{ name: 'c', run }, { name: 'fine', run: () => {} }] }]);
        expect(s).toMatchObject({ total: 2, passed: 1, failed: 1 });
        expect(s.groups[0]).toMatchObject({ passed: 1, failed: 1 });
        expect(s.results[0].ok).toBe(false);
        expect(typeof s.results[0].error).toBe('string');
        expect(s.results[0].error.trim().length).toBeGreaterThan(0); // and the page always has something to show
        expect(s.results[1].ok).toBe(true);
      });
    }

    it('a check that returns normally is a pass, even if it returns a falsy value, an empty string or an error-looking value', async () => {
      const returns = [undefined, null, 0, '', false, NaN, new Error('not thrown'), { error: 'x' }];
      const s = await runChecks([{ id: 'x', title: 'X', checks: returns.map((v, i) => ({ name: `returns ${i}`, run: () => v })) }]);
      expect(s).toMatchObject({ total: 8, passed: 8, failed: 0 });
      expect(s.results.every((r) => r.ok && r.error === null)).toBe(true);
    });

    it('the totals add up when many things are thrown', async () => {
      const checks = Object.entries(thrown).map(([name, run]) => ({ name, run }));
      const s = await runChecks([{ id: 'x', title: 'X', checks }]);
      expect(s.failed).toBe(checks.length);
      expect(s.passed).toBe(0);
      expect(s.results.every((r) => !r.ok)).toBe(true);
    });

    it('the order of results is kept after failures', async () => {
      const s = await runChecks([{ id: 'x', title: 'X', checks: [
        { name: 'a', run: () => { throw ''; } }, { name: 'b', run: () => {} }, { name: 'c', run: () => { throw new Error(''); } }, { name: 'd', run: () => {} },
      ] }]);
      expect(s.results.map((r) => [r.name, r.ok])).toEqual([['a', false], ['b', true], ['c', false], ['d', true]]);
    });

    it('describeError: a real message is kept as it is; the rest becomes readable text', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
      expect(describeError('plain text')).toBe('plain text');
      expect(describeError(new Error(''))).toMatch(/^Error \(thrown with an empty message\)$/);
      expect(describeError(new TypeError(''))).toMatch(/^TypeError/);
      expect(describeError('')).toMatch(/no text was thrown/);
      expect(describeError(undefined)).toBe('undefined');
      expect(describeError(null)).toBe('null');
      expect(describeError(0)).toBe('0');
      expect(describeError({})).toBe('[object Object]');
    });
  });

  describe('the helpers of the in-page checks never accept an empty message as "fine"', () => {
    it('assert with no or an empty message still throws a message with text', () => {
      for (const args of [[false], [false, ''], [0, ''], [null], [undefined, '']]) {
        try { assert(...args); } catch (e) { expect(e.message.length).toBeGreaterThan(0); continue; }
        throw new Error('assert did not throw');
      }
      expect(() => assert(true, '')).not.toThrow();
    });

    it('until() accepts only null as success: an empty text is a problem, and a fixed problem passes', async () => {
      const frame = { contentWindow: { requestAnimationFrame: (cb) => setTimeout(cb, 0), document: {} } };
      const driver = createUiDriver(frame);
      await expect(driver.until(() => '', 30)).rejects.toThrow(/did not pass/);
      await expect(driver.until(() => 'still wrong', 30)).rejects.toThrow('still wrong');
      await expect(driver.until(() => null, 30)).resolves.toBeUndefined();
      let n = 0;
      await expect(driver.until(() => (++n < 3 ? 'not yet' : null), 500)).resolves.toBeUndefined();
      expect(n).toBe(3);
      let m = 0;
      await expect(driver.until(() => (++m < 3 ? '' : null), 500)).resolves.toBeUndefined(); // an empty problem is still a problem: it is tried again
      expect(m).toBe(3);
    });
  });

  it('the runner skips groups with no selected checks', async () => {
    const s = await runChecks([{ id: 'a', title: 'A', checks: [{ name: 'ui only', ui: true, run: () => {} }] }], { include: (c) => !c.ui });
    expect(s.total).toBe(0);
    expect(s.groups).toEqual([]);
  });
});
