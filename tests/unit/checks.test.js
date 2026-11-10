import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGroups } from '../../checks/definitions.js';
import { runChecks } from '../../checks/runner.js';
import { parseKline } from '../../src/live.js';

const rows = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const ctx = { realRows: async () => rows, realCandles: async () => rows.map(parseKline) };

describe('the in-page check suite (everything that does not need a browser)', () => {
  it('has the expected groups', () => {
    expect(buildGroups(ctx).map((g) => g.id)).toEqual(['sma', 'ema', 'bb', 'rsi', 'data', 'binance']);
  });

  it('all checks pass and each group reports its time', async () => {
    const events = [];
    const summary = await runChecks(buildGroups(ctx), { include: (c) => !c.ui, onCheck: (e) => events.push(e.index) });
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(summary.passed);
    expect(summary.total).toBeGreaterThan(150);
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
