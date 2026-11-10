import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGroups } from '../../checks/definitions.js';
import { runChecks } from '../../checks/runner.js';
import { parseKline } from '../../src/live.js';

const rows = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const talib = JSON.parse(readFileSync(new URL('../fixtures/talib-reference.json', import.meta.url)));
const ctx = { realRows: async () => rows, realCandles: async () => rows.map(parseKline), talibReference: async () => talib };

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
    const tampered = rows.map(parseKline).map((c, i) => { const d = (i % 3) * 37; return { ...c, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d }; }); // RSI ignores a constant shift, so shift bars differently
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

  it('the runner skips groups with no selected checks', async () => {
    const s = await runChecks([{ id: 'a', title: 'A', checks: [{ name: 'ui only', ui: true, run: () => {} }] }], { include: (c) => !c.ui });
    expect(s.total).toBe(0);
    expect(s.groups).toEqual([]);
  });
});
