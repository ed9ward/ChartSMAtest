import { test, expect, open, smaData, candleData, expectLineAt } from './fixtures.js';
import { mulberry32 } from '../../src/generator.js';
import { SOURCES } from '../../src/sma.js';
import { SCENARIOS } from '../../src/scenarios.js';
import { refSMA, expectSeriesClose, expectedBars } from '../unit/helpers.js';

const fmt = (n) => n.toFixed(2);
const ohlc = ({ time, open, high, low, close }) => ({ time, open, high, low, close });

// One atomic read of everything the chart holds right now.
const snapshot = (page) => page.evaluate(() => ({
  ...window.__app.state(), candles: window.__app.candleData(), sma: window.__app.smaData(),
}));

// Applies settings changes and ticks the way a user and a feed would, all in one page turn.
function runOps(page, ops) {
  return page.evaluate((list) => {
    for (const op of list) {
      if (op.type === 'step') window.__app.step();
      else if (op.type === 'source') {
        const sel = document.getElementById('source');
        sel.value = op.value;
        sel.dispatchEvent(new Event('change'));
      } else {
        const inp = document.getElementById('period');
        inp.value = String(op.value);
        inp.dispatchEvent(new Event('input'));
      }
    }
  }, ops);
}

// Mirrors what the app should do with a list of operations.
function expectedState(ops, start = 60) {
  let source = 'close', period = 20, steps = 0;
  for (const op of ops) {
    if (op.type === 'step') steps++;
    else if (op.type === 'source') source = op.value;
    else if (Number.isInteger(op.value) && op.value >= 1) period = op.value;
  }
  return { source, period, steps, bars: expectedBars(start, steps) };
}

test.describe('feed connection lost and restored', () => {
  test('no data arrives while disconnected; reconnect backfills history correctly', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await expect.poll(async () => (await snapshot(page)).ticks).toBeGreaterThanOrEqual(3);
    await page.getByTestId('disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('Feed disconnected');

    const before = await snapshot(page);
    expect(before.offline).toBe(true);
    await page.waitForTimeout(700);
    const during = await snapshot(page);
    expect(during.ticks).toBe(before.ticks);
    expect(during.candles).toEqual(before.candles);

    await page.getByTestId('reconnect').click();
    await expect(page.getByTestId('status')).toHaveText('OK');
    // ~700 ms offline = at least 3 missed ticks must arrive at once as history, not trickle in live
    expect((await snapshot(page)).ticks).toBeGreaterThanOrEqual(before.ticks + 3);
    await page.getByTestId('stop').click();

    const after = await snapshot(page);
    const bars = expectedBars(60, after.ticks);
    expect(after.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(after.sma, refSMA(bars, 20, 'close'));
    // no holes in history: bars are exactly one interval apart
    after.candles.slice(1).forEach((c, i) => expect(c.time - after.candles[i].time).toBe(60));
  });

  test('backfill of a known number of missed ticks', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await page.evaluate(() => { window.__app.disconnect(); });
    const { ticks: t0 } = await snapshot(page);
    // reconnect delivers 23 missed ticks, then we pause so the result is deterministic
    await page.evaluate(() => { window.__app.reconnect(23); window.__app.stop(); });
    const after = await snapshot(page);
    expect(after.ticks).toBe(t0 + 23);
    const bars = expectedBars(60, after.ticks);
    expect(after.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(after.sma, refSMA(bars, 20, 'close'));
    await expect(page.getByTestId('bar-count')).toHaveText(String(bars.length));
    await expect(page.getByTestId('last-close')).toHaveText(fmt(bars.at(-1).close));
  });

  test('several disconnect / reconnect cycles in a row', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    for (const missed of [2, 0, 9, 1, 14]) {
      await page.evaluate((m) => { window.__app.disconnect(); window.__app.reconnect(m); }, missed);
    }
    await page.getByTestId('stop').click();
    const after = await snapshot(page);
    const bars = expectedBars(60, after.ticks);
    expect(after.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(after.sma, refSMA(bars, 20, 'close'));
  });

  test('settings changed while disconnected apply to the backfilled history', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await page.getByTestId('disconnect').click();
    await page.getByTestId('source').selectOption('hl2');
    await page.getByTestId('period').fill('8');
    await page.evaluate(() => { window.__app.reconnect(17); window.__app.stop(); });
    const after = await snapshot(page);
    expectSeriesClose(after.sma, refSMA(expectedBars(60, after.ticks), 8, 'hl2'));
  });

  test('reconnect without a disconnect and disconnect without a stream do nothing', async ({ page }) => {
    await open(page);
    const before = await snapshot(page);
    await page.evaluate(() => { window.__app.reconnect(10); window.__app.disconnect(); });
    expect(await snapshot(page)).toEqual(before);
    await expect(page.getByTestId('status')).toHaveText('OK');
  });

  test('stop and start continue the same candle instead of skipping it', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await expect.poll(async () => (await snapshot(page)).ticks).toBeGreaterThanOrEqual(2);
    await page.getByTestId('stop').click();
    const paused = await snapshot(page);
    expect(paused.streaming).toBe(false);
    expect(paused.candles.map(ohlc)).toEqual(expectedBars(60, paused.ticks).map(ohlc));

    await page.getByTestId('start').click();
    await expect.poll(async () => (await snapshot(page)).ticks).toBeGreaterThanOrEqual(paused.ticks + 8);
    await page.getByTestId('stop').click();
    const after = await snapshot(page);
    expect(after.candles.map(ohlc)).toEqual(expectedBars(60, after.ticks).map(ohlc));
  });
});

test.describe('settings changed while streaming', () => {
  test('a fixed sequence of ticks and setting changes', async ({ page }) => {
    await open(page);
    const ops = [
      ...Array(3).fill({ type: 'step' }), { type: 'source', value: 'low' },
      ...Array(2).fill({ type: 'step' }), { type: 'period', value: 7 },
      ...Array(4).fill({ type: 'step' }), { type: 'source', value: 'ohlc4' }, { type: 'period', value: 3 },
      { type: 'step' },
    ];
    await runOps(page, ops);
    const exp = expectedState(ops);
    const snap = await snapshot(page);
    expect(snap.candles.map(ohlc)).toEqual(exp.bars.map(ohlc));
    expectSeriesClose(snap.sma, refSMA(exp.bars, exp.period, exp.source));
  });

  test('200 random operations, including invalid periods, end in a consistent state', async ({ page }) => {
    await open(page);
    const rnd = mulberry32(2026);
    const ops = Array.from({ length: 200 }, () => {
      const r = rnd();
      if (r < 0.4) return { type: 'step' };
      if (r < 0.7) return { type: 'source', value: SOURCES[Math.floor(rnd() * SOURCES.length)] };
      return { type: 'period', value: [0, -2, 1, 2, 5, 13, 20, 40, 75, 1.5][Math.floor(rnd() * 10)] };
    });
    await runOps(page, ops);
    const exp = expectedState(ops);
    const snap = await snapshot(page);
    expect(snap.candles.map(ohlc)).toEqual(exp.bars.map(ohlc));
    expectSeriesClose(snap.sma, refSMA(exp.bars, exp.period, exp.source));
    expect(snap.period).toBe(exp.period);
    expect(snap.source).toBe(exp.source);
  });

  test('fast switching against a real running stream', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    for (let i = 0; i < 25; i++) {
      await page.getByTestId('source').selectOption(SOURCES[i % SOURCES.length]);
      await page.getByTestId('period').fill(String(1 + ((i * 7) % 30)));
    }
    await page.getByTestId('source').selectOption('hlc3');
    await page.getByTestId('period').fill('12');
    await page.getByTestId('stop').click();
    const snap = await snapshot(page);
    const bars = expectedBars(60, snap.ticks);
    expect(snap.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(snap.sma, refSMA(bars, 12, 'hlc3'));
  });

  test('changing the data set during a stream stops it and resets the feed', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await expect.poll(async () => (await snapshot(page)).ticks).toBeGreaterThanOrEqual(2);
    await page.getByTestId('scenario').selectOption('negative');
    const snap = await snapshot(page);
    expect(snap.streaming).toBe(false);
    expect(snap.ticks).toBe(0);
    await page.waitForTimeout(500);
    expect((await snapshot(page)).candles).toHaveLength(60);
  });
});

test.describe('first candle of an empty chart', () => {
  test('first tick creates the first bar; SMA stays empty until the window is full', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('empty');
    await page.evaluate(() => window.__app.step());
    await expect(page.getByTestId('bar-count')).toHaveText('1');
    expect(await smaData(page)).toEqual([]);
    await expect(page.getByTestId('last-sma')).toHaveText('—');
    await expect(page.getByTestId('last-close')).toHaveText(fmt(expectedBars(0, 1)[0].close));
  });

  test('with period 1 the SMA equals the source from the very first tick', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('empty');
    await page.getByTestId('period').fill('1');
    await page.getByTestId('source').selectOption('ohlc4');
    for (let steps = 1; steps <= 12; steps++) {
      await page.evaluate(() => window.__app.step());
      const bars = expectedBars(0, steps);
      expectSeriesClose(await smaData(page), refSMA(bars, 1, 'ohlc4'));
    }
  });

  test('the first candle grows to its final shape in 5 ticks', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('empty');
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.__app.step());
    expect((await candleData(page)).map(ohlc)).toEqual(expectedBars(0, 5).map(ohlc));
  });

  test('a stream started on an empty chart delivers bars', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('empty');
    await page.getByTestId('start').click();
    await expect.poll(async () => (await snapshot(page)).ticks, { timeout: 8000 }).toBeGreaterThanOrEqual(6);
    await page.getByTestId('stop').click();
    const snap = await snapshot(page);
    expect(snap.candles.map(ohlc)).toEqual(expectedBars(0, snap.ticks).map(ohlc));
  });
});

test.describe('window size', () => {
  for (const [w, h] of [[320, 700], [480, 800], [800, 500], [1400, 900]]) {
    test(`${w}x${h}: chart follows the container, line stays where it should`, async ({ page }) => {
      await open(page);
      await page.setViewportSize({ width: w, height: h });
      const expectedWidth = Math.min(900, w - 32);
      await expect.poll(() => page.evaluate(() => window.__app.chart.takeScreenshot().width)).toBe(expectedWidth);
      await expectLineAt(page);
      await expect(page.getByTestId('bar-count')).toHaveText('60');
      expect(await smaData(page)).toHaveLength(41);
    });
  }

  test('shrinking and growing back keeps data and SMA intact', async ({ page }) => {
    await open(page);
    const before = await snapshot(page);
    await page.setViewportSize({ width: 360, height: 600 });
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => page.evaluate(() => window.__app.chart.takeScreenshot().width)).toBe(900);
    const after = await snapshot(page);
    expect(after.candles).toEqual(before.candles);
    expect(after.sma).toEqual(before.sma);
  });

  test('resizing during a running stream does not break updates', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    for (const w of [500, 900, 400, 1100]) await page.setViewportSize({ width: w, height: 700 });
    await page.getByTestId('stop').click();
    const snap = await snapshot(page);
    const bars = expectedBars(60, snap.ticks);
    expect(snap.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(snap.sma, refSMA(bars, 20, 'close'));
  });
});

test.describe('2000 bars', () => {
  const long = SCENARIOS.long();

  test('all sources match the reference with a long period', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    await expect(page.getByTestId('bar-count')).toHaveText('2000');
    await page.getByTestId('period').fill('200');
    for (const source of SOURCES) {
      await page.getByTestId('source').selectOption(source);
      expectSeriesClose(await smaData(page), refSMA(long, 200, source));
    }
  });

  test('switching settings on 2000 bars stays fast', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    const ms = await page.evaluate(() => {
      const t = performance.now();
      const inp = document.getElementById('period');
      for (let p = 1; p <= 50; p++) { inp.value = String(p * 4); inp.dispatchEvent(new Event('input')); }
      return performance.now() - t;
    });
    expect(ms).toBeLessThan(5000);
    expectSeriesClose(await smaData(page), refSMA(long, 200, 'close'));
  });

  test('streaming continues the long data set', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__app.step(); });
    const bars = expectedBars(2000, 8);
    const snap = await snapshot(page);
    expect(snap.candles.map(ohlc)).toEqual(bars.map(ohlc));
    expectSeriesClose(snap.sma, refSMA(bars, 20, 'close'));
  });

  test('line is drawn at the right place on a dense chart', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    // 2000 bars in ~900 px: several bars share a pixel column, so the line is steeper and a bit taller there
    await expectLineAt(page, { tolerance: 5 });
  });
});


test.describe('performance and long-lived chart resources', () => {
  test('1000-candle setData and full redraw stay within the browser budget', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    const setDataMs = await page.evaluate(() => {
      const candles = window.__app.rawCandleData().slice(-1000);
      const series = window.__app.candleSeries;
      const started = performance.now();
      series.setData(candles);
      return performance.now() - started;
    });
    expect(setDataMs).toBeLessThan(1000);

    const redrawMs = await page.evaluate(() => {
      const source = document.getElementById('source');
      const period = document.getElementById('period');
      const started = performance.now();
      for (let i = 0; i < 25; i++) {
        source.value = ['close', 'hl2', 'hlc3', 'ohlc4'][i % 4];
        source.dispatchEvent(new Event('change'));
        period.value = String(5 + (i % 40));
        period.dispatchEvent(new Event('input'));
      }
      return performance.now() - started;
    });
    expect(redrawMs).toBeLessThan(5000);
    await expect(page.getByTestId('bar-count')).toHaveText('2000');
  });

  test('1000 incremental feed updates do not trigger an unbounded chart rebuild', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    const result = await page.evaluate(() => {
      const series = window.__app.candleSeries;
      let setDataCalls = 0;
      let updateCalls = 0;
      const setData = series.setData.bind(series);
      const update = series.update.bind(series);
      series.setData = (...args) => { setDataCalls++; return setData(...args); };
      series.update = (...args) => { updateCalls++; return update(...args); };
      const started = performance.now();
      for (let i = 0; i < 1000; i++) window.__app.step();
      return {
        elapsedMs: performance.now() - started,
        setDataCalls,
        updateCalls,
        bars: window.__app.rawCandleData().length,
      };
    });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.setDataCalls).toBe(0);
    expect(result.updateCalls).toBe(1000);
    expect(result.bars).toBe(2200);
  });

  test('repeated indicator switches remove obsolete series instead of accumulating them', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
      const chart = window.__app.chart;
      let added = 0;
      let removed = 0;
      const addSeries = chart.addSeries.bind(chart);
      const removeSeries = chart.removeSeries.bind(chart);
      chart.addSeries = (...args) => { added++; return addSeries(...args); };
      chart.removeSeries = (...args) => { removed++; return removeSeries(...args); };
      const indicator = document.getElementById('indicator');
      const kinds = ['sma', 'ema', 'bb', 'rsi'];
      for (let i = 0; i < 160; i++) {
        indicator.value = kinds[i % kinds.length];
        indicator.dispatchEvent(new Event('change'));
      }
      const active = Object.keys(window.__app.lineSeries()).length;
      return { added, removed, active, difference: added - removed };
    });
    expect(result.added).toBeGreaterThan(100);
    expect(result.removed).toBeGreaterThan(100);
    expect(result.difference).toBe(0); // the initial SMA series exists before instrumentation; every switch must balance add/remove
    expect(result.active).toBe(1); // final selection is RSI
    expect(await page.getByTestId('bar-count').textContent()).toBe('60');
  });

  test('start/stop cycles leave no active demo timer', async ({ page }) => {
    await open(page);
    const state = await page.evaluate(() => {
      for (let i = 0; i < 100; i++) {
        document.getElementById('start').click();
        document.getElementById('stop').click();
      }
      return window.__app.state();
    });
    expect(state.streaming).toBe(false);
    expect(state.ticks).toBe(0);
  });
});
