import { test, expect, open, candleData, probeLine, expectLineAt } from './fixtures.js';
import { SOURCES } from '../../src/sma.js';
import { SCENARIOS } from '../../src/scenarios.js';
import { sanitizeCandles } from '../../src/sanitize.js';
import { mulberry32 } from '../../src/generator.js';
import { refSMA, refEMA, refBB, refRSI, expectSeriesClose, expectedBars } from '../unit/helpers.js';

const NORMAL = SCENARIOS.normal();
const fmt = (n) => n.toFixed(2);

const KINDS = {
  sma: { label: 'SMA', period: 20, keys: ['sma'], panes: 1, ref: (c, p, s) => ({ sma: refSMA(c, p.period, s) }) },
  ema: { label: 'EMA', period: 20, keys: ['ema'], panes: 1, ref: (c, p, s) => ({ ema: refEMA(c, p.period, s, p.start) }) },
  bb: { label: 'BB', period: 20, keys: ['basis', 'upper', 'lower'], panes: 1, ref: (c, p, s) => refBB(c, p.period, p.mult ?? 2, s) },
  rsi: { label: 'RSI', period: 14, keys: ['rsi'], panes: 2, ref: (c, p, s) => ({ rsi: refRSI(c, p.period, s, { flat: 100 }) }) },
};
const PRIMARY = { sma: 'sma', ema: 'ema', bb: 'basis', rsi: 'rsi' };

const lineData = (page, key) => page.evaluate((k) => window.__app.lineData(k), key);
const paneCount = (page) => page.evaluate(() => window.__app.chart.panes().length);
const lineKeys = (page) => page.evaluate(() => Object.keys(window.__app.lineSeries()));
const snapshot = (page) => page.evaluate(() => ({ ...window.__app.state(), candles: window.__app.candleData() }));

async function pick(page, kind, { source, period, scenario } = {}) {
  if (scenario) await page.getByTestId('scenario').selectOption(scenario);
  await page.getByTestId('indicator').selectOption(kind);
  if (source) await page.getByTestId('source').selectOption(source);
  if (period !== undefined) await page.getByTestId('period').fill(String(period));
}

async function expectLines(page, kind, candles, params, source) {
  const want = KINDS[kind].ref(candles, params, source);
  for (const key of KINDS[kind].keys) expectSeriesClose(await lineData(page, key), want[key]);
}

for (const [kind, info] of Object.entries(KINDS)) {
  test.describe(`${info.label}`, () => {
    test('selecting it shows the right label, default period, lines and panes', async ({ page }) => {
      await open(page);
      await pick(page, kind);
      await expect(page.getByTestId('legend-label')).toHaveText(info.label);
      await expect(page.getByTestId('period')).toHaveValue(String(info.period));
      await expect(page.getByTestId('mult')).toBeVisible({ visible: kind === 'bb' });
      await expect(page.getByTestId('ema-start')).toBeVisible({ visible: kind === 'ema' });
      expect(await lineKeys(page)).toEqual(info.keys);
      expect(await paneCount(page)).toBe(info.panes);
      await expect(page.getByTestId('status')).toHaveText('OK');
    });

    for (const source of SOURCES) {
      test(`source ${source} matches the reference`, async ({ page }) => {
        await open(page);
        await pick(page, kind, { source });
        await expectLines(page, kind, NORMAL, { period: info.period }, source);
      });
    }

    for (const period of [1, 2, 7, 60, 61]) {
      test(`period ${period} matches the reference`, async ({ page }) => {
        await open(page);
        await pick(page, kind, { period });
        await expectLines(page, kind, NORMAL, { period }, 'close');
        await expect(page.getByTestId('status')).toHaveText('OK');
      });
    }

    test('legend shows the last value of the main line', async ({ page }) => {
      await open(page);
      await pick(page, kind, { source: 'hl2' });
      const want = info.ref(NORMAL, { period: info.period }, 'hl2')[PRIMARY[kind]].at(-1).value;
      await expect(page.getByTestId('last-sma')).toHaveText(fmt(want));
    });

    for (const bad of ['0', '-3', '1.5', '']) {
      test(`invalid period "${bad}" shows an error and keeps the lines`, async ({ page }) => {
        await open(page);
        await pick(page, kind);
        const before = await Promise.all(info.keys.map((k) => lineData(page, k)));
        await page.getByTestId('period').fill(bad);
        await expect(page.getByTestId('status')).toContainText('Invalid period');
        expect(await Promise.all(info.keys.map((k) => lineData(page, k)))).toEqual(before);
      });
    }

    test('every line is drawn at the right height on the canvas', async ({ page }) => {
      await open(page);
      await pick(page, kind);
      for (const key of info.keys) {
        await expectLineAt(page, { key });
      }
    });

    for (const steps of [1, 3, 5, 6, 12]) {
      test(`after ${steps} live ticks the lines match the reference`, async ({ page }) => {
        await open(page);
        await pick(page, kind, { source: 'ohlc4' });
        await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__app.step(); }, steps);
        await expectLines(page, kind, expectedBars(60, steps), { period: info.period }, 'ohlc4');
      });
    }

    for (const name of ['negative', 'huge', 'overflow', 'nan', 'inconsistent', 'duplicates', 'unordered', 'empty']) {
      test(`strange data "${name}": page survives, lines match the reference`, async ({ page }) => {
        await open(page);
        await pick(page, kind, { scenario: name });
        const expected = sanitizeCandles(SCENARIOS[name]()).candles;
        await expectLines(page, kind, expected, { period: info.period }, 'close');
        await expect(page.getByTestId('bar-count')).toHaveText(String(expected.length));
      });
    }

    test('a real running stream keeps the lines correct', async ({ page }) => {
      await open(page);
      await pick(page, kind);
      await page.getByTestId('start').click();
      await expect.poll(async () => (await snapshot(page)).ticks, { timeout: 8000 }).toBeGreaterThanOrEqual(7);
      await page.getByTestId('stop').click();
      const snap = await snapshot(page);
      await expectLines(page, kind, expectedBars(60, snap.ticks), { period: info.period }, 'close');
    });

    test('disconnect and reconnect backfill the lines', async ({ page }) => {
      await open(page);
      await pick(page, kind);
      await page.getByTestId('start').click();
      await page.evaluate(() => window.__app.disconnect());
      await page.evaluate(() => { window.__app.reconnect(23); window.__app.stop(); });
      const snap = await snapshot(page);
      await expectLines(page, kind, expectedBars(60, snap.ticks), { period: info.period }, 'close');
    });
  });
}

test.describe('EMA start', () => {
  test('defaults to the first value (TradingView) and offers the TA-Lib start', async ({ page }) => {
    await open(page);
    await pick(page, 'ema');
    await expect(page.getByTestId('ema-start')).toHaveValue('first');
    expect(await page.getByTestId('ema-start').locator('option').allTextContents()).toEqual(['First value (TradingView)', 'SMA of first N (TA-Lib)']);
    expect(await page.evaluate(() => window.__app.state().start)).toBe('first');
  });

  test('the first-value start has a point on every bar, the SMA start from bar `period`', async ({ page }) => {
    await open(page);
    await pick(page, 'ema');
    expect(await lineData(page, 'ema')).toHaveLength(60);
    await page.getByTestId('ema-start').selectOption('sma');
    expect(await lineData(page, 'ema')).toHaveLength(41);
  });

  for (const start of ['first', 'sma']) {
    for (const period of [5, 20, 60]) {
      test(`${start} start, period ${period} matches the reference`, async ({ page }) => {
        await open(page);
        await pick(page, 'ema');
        await page.getByTestId('ema-start').selectOption(start);
        await page.getByTestId('period').fill(String(period));
        expectSeriesClose(await lineData(page, 'ema'), refEMA(NORMAL, period, 'close', start));
      });
    }

    test(`${start} start: the line is drawn at the right height`, async ({ page }) => {
      await open(page);
      await pick(page, 'ema');
      await page.getByTestId('ema-start').selectOption(start);
      await expectLineAt(page);
    });

    test(`${start} start: live ticks keep the line correct`, async ({ page }) => {
      await open(page);
      await pick(page, 'ema', { source: 'hlc3' });
      await page.getByTestId('ema-start').selectOption(start);
      await page.evaluate(() => { for (let i = 0; i < 12; i++) window.__app.step(); });
      expectSeriesClose(await lineData(page, 'ema'), refEMA(expectedBars(60, 12), 20, 'hlc3', start));
    });
  }

  test('the start is kept when the period or the source changes, and the legend follows it', async ({ page }) => {
    await open(page);
    await pick(page, 'ema');
    await page.getByTestId('ema-start').selectOption('sma');
    await page.getByTestId('period').fill('9');
    await page.getByTestId('source').selectOption('ohlc4');
    await expect(page.getByTestId('ema-start')).toHaveValue('sma');
    const want = refEMA(NORMAL, 9, 'ohlc4', 'sma').at(-1).value;
    await expect(page.getByTestId('last-sma')).toHaveText(fmt(want));
  });

  test('a long period on a short history: the two starts give clearly different last values', async ({ page }) => {
    await open(page);
    await pick(page, 'ema', { period: 40 });
    const first = (await lineData(page, 'ema')).at(-1).value;
    await page.getByTestId('ema-start').selectOption('sma');
    const sma = (await lineData(page, 'ema')).at(-1).value;
    expect(Math.abs(first - sma)).toBeGreaterThan(0.05);
    expect(first).toBeCloseTo(refEMA(NORMAL, 40, 'close', 'first').at(-1).value, 6);
    expect(sma).toBeCloseTo(refEMA(NORMAL, 40, 'close', 'sma').at(-1).value, 6);
  });

  test('selecting EMA again returns to the default start; other indicators do not show the selector', async ({ page }) => {
    await open(page);
    await pick(page, 'ema');
    await page.getByTestId('ema-start').selectOption('sma');
    await pick(page, 'sma');
    await expect(page.getByTestId('ema-start')).toBeHidden();
    await pick(page, 'ema');
    await expect(page.getByTestId('ema-start')).toHaveValue('first');
    expectSeriesClose(await lineData(page, 'ema'), refEMA(NORMAL, 20, 'close', 'first'));
  });

  test('strange data works with both starts', async ({ page }) => {
    await open(page);
    await pick(page, 'ema', { scenario: 'nan' });
    for (const start of ['first', 'sma']) {
      await page.getByTestId('ema-start').selectOption(start);
      const expected = sanitizeCandles(SCENARIOS.nan()).candles;
      expectSeriesClose(await lineData(page, 'ema'), refEMA(expected, 20, 'close', start));
    }
  });
});

test.describe('Bollinger multiplier', () => {
  test('visible only for Bollinger Bands', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('mult')).toBeHidden();
    await pick(page, 'bb');
    await expect(page.getByTestId('mult')).toBeVisible();
    await pick(page, 'rsi');
    await expect(page.getByTestId('mult')).toBeHidden();
  });

  test('the band legend is shown only for Bollinger Bands', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('last-bb-upper')).toBeHidden();
    await pick(page, 'bb');
    await expect(page.getByTestId('last-bb-upper')).toBeVisible();
    await expect(page.getByTestId('last-bb-lower')).toBeVisible();
    await pick(page, 'ema');
    await expect(page.getByTestId('last-bb-upper')).toBeHidden();
  });

  for (const mult of [0, 1, 3.5]) {
    test(`multiplier ${mult} matches the reference`, async ({ page }) => {
      await open(page);
      await pick(page, 'bb');
      await page.getByTestId('mult').fill(String(mult));
      await expectLines(page, 'bb', NORMAL, { period: 20, mult }, 'close');
    });
  }

  test('multiplier 0 puts both bands on the basis', async ({ page }) => {
    await open(page);
    await pick(page, 'bb');
    await page.getByTestId('mult').fill('0');
    expect(await lineData(page, 'upper')).toEqual(await lineData(page, 'basis'));
    expect(await lineData(page, 'lower')).toEqual(await lineData(page, 'basis'));
  });

  for (const bad of ['-1', '']) {
    test(`invalid multiplier "${bad}" shows an error and keeps the bands`, async ({ page }) => {
      await open(page);
      await pick(page, 'bb');
      const before = await lineData(page, 'upper');
      await page.getByTestId('mult').fill(bad);
      await expect(page.getByTestId('status')).toContainText('Invalid multiplier');
      expect(await lineData(page, 'upper')).toEqual(before);
    });
  }

  test('legend shows the upper and lower band', async ({ page }) => {
    await open(page);
    await pick(page, 'bb', { period: 10 });
    await page.getByTestId('mult').fill('3');
    const want = refBB(NORMAL, 10, 3, 'close');
    await expect(page.getByTestId('last-bb-upper')).toBeVisible();
    await expect(page.getByTestId('last-bb-upper')).toHaveText(fmt(want.upper.at(-1).value));
    await expect(page.getByTestId('last-bb-lower')).toHaveText(fmt(want.lower.at(-1).value));
    await expect(page.getByTestId('last-sma')).toHaveText(fmt(want.basis.at(-1).value));
  });

  test('the multiplier survives a source change and a live tick', async ({ page }) => {
    await open(page);
    await pick(page, 'bb');
    await page.getByTestId('mult').fill('2.5');
    await page.getByTestId('source').selectOption('hl2');
    await page.evaluate(() => { window.__app.step(); window.__app.step(); });
    await expectLines(page, 'bb', expectedBars(60, 2), { period: 20, mult: 2.5 }, 'hl2');
  });
});

test.describe('RSI pane', () => {
  test('values stay within 0..100 and the second pane exists only for RSI', async ({ page }) => {
    await open(page);
    await pick(page, 'rsi');
    expect(await paneCount(page)).toBe(2);
    expect((await lineData(page, 'rsi')).every((p) => p.value >= 0 && p.value <= 100)).toBe(true);
    await pick(page, 'sma');
    expect(await paneCount(page)).toBe(1);
  });

  test('RSI is not drawn on the price scale: its line sits in the lower pane', async ({ page }) => {
    await open(page);
    await pick(page, 'rsi');
    await expect.poll(async () => {
      const probe = await probeLine(page, 'rsi');
      return probe?.ys.length ? Math.min(...probe.ys) : 0;
    }).toBeGreaterThan(250); // below the price pane
  });
});

test.describe('switching indicators', () => {
  test('keeps candles and source, applies the new default period, clears an old error', async ({ page }) => {
    await open(page);
    await page.getByTestId('source').selectOption('low');
    await page.getByTestId('period').fill('0');
    await expect(page.getByTestId('status')).toContainText('Invalid period');
    const candlesBefore = await candleData(page);
    await pick(page, 'rsi');
    await expect(page.getByTestId('status')).toHaveText('OK');
    await expect(page.getByTestId('period')).toHaveValue('14');
    await expect(page.getByTestId('source')).toHaveValue('low');
    expect(await candleData(page)).toEqual(candlesBefore);
    await expectLines(page, 'rsi', NORMAL, { period: 14 }, 'low');
  });

  test('60 random switches never leak series or panes and end consistent', async ({ page }) => {
    await open(page);
    const rnd = mulberry32(77);
    const kinds = Object.keys(KINDS);
    let kind = 'sma';
    for (let i = 0; i < 60; i++) {
      kind = kinds[Math.floor(rnd() * kinds.length)];
      await page.getByTestId('indicator').selectOption(kind);
      if (i % 7 === 0) await page.evaluate(() => window.__app.step());
    }
    expect(await lineKeys(page)).toEqual(KINDS[kind].keys);
    expect(await paneCount(page)).toBe(KINDS[kind].panes);
    const ticks = (await snapshot(page)).ticks;
    await expectLines(page, kind, expectedBars(60, ticks), { period: KINDS[kind].period }, 'close');
  });

  test('switching while a real stream runs', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    for (const kind of ['ema', 'bb', 'rsi', 'sma', 'rsi', 'bb']) await pick(page, kind);
    await page.getByTestId('stop').click();
    const snap = await snapshot(page);
    expect(snap.indicator).toBe('bb');
    await expectLines(page, 'bb', expectedBars(60, snap.ticks), { period: 20 }, 'close');
  });

  test('changing the data set keeps the selected indicator', async ({ page }) => {
    await open(page);
    await pick(page, 'ema');
    await page.getByTestId('scenario').selectOption('long');
    await expectLines(page, 'ema', SCENARIOS.long(), { period: 20 }, 'close');
    expect((await snapshot(page)).indicator).toBe('ema');
  });
});

test.describe('flat and stalled markets', () => {
  test('a flat market: every indicator gives the price, RSI is 100 (the TradingView convention), nothing breaks', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('flat');
    await expect(page.getByTestId('status')).toHaveText('OK');
    for (const [kind, keys] of [['sma', ['sma']], ['ema', ['ema']], ['bb', ['basis', 'upper', 'lower']], ['rsi', ['rsi']]]) {
      await pick(page, kind);
      for (const key of keys) {
        const data = await lineData(page, key);
        expect(data.length, `${kind}/${key}`).toBeGreaterThan(0);
        expect(data.every((p) => p.value === 100), `${kind}/${key}`).toBe(true);
      }
    }
    await expect(page.getByTestId('last-sma')).toHaveText('100.00');
  });

  test('a flat market with the SMA start of the EMA, and with a short and a long RSI period', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('flat');
    await pick(page, 'ema');
    await page.getByTestId('ema-start').selectOption('sma');
    expect((await lineData(page, 'ema')).every((p) => p.value === 100)).toBe(true);
    for (const period of [1, 2, 14, 59]) {
      await pick(page, 'rsi', { period });
      const data = await lineData(page, 'rsi');
      expect(data, `period ${period}`).toHaveLength(60 - period);
      expect(data.every((p) => p.value === 100), `period ${period}`).toBe(true);
    }
  });

  test('a stalled market: the RSI stays at its last value after the price stops, and matches the reference', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('stalled');
    await pick(page, 'rsi');
    const stalled = sanitizeCandles(SCENARIOS.stalled()).candles;
    expectSeriesClose(await lineData(page, 'rsi'), refRSI(stalled, 14, 'close')); // no convention needed: something moved
    const data = await lineData(page, 'rsi');
    const stopAt = stalled[30].time; // the last bar with a move
    const atStop = data.find((p) => p.time === stopAt).value;
    const after = data.filter((p) => p.time > stopAt);
    expect(after.length).toBeGreaterThan(20);
    for (const p of after) expect(p.value).toBeCloseTo(atStop, 9);
    expect(atStop).toBeGreaterThan(50);
    expect(atStop).toBeLessThan(100);
    await expect(page.getByTestId('last-sma')).toHaveText(atStop.toFixed(2));
  });

  test('a stalled market: the other indicators settle on the final price', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('stalled');
    const price = sanitizeCandles(SCENARIOS.stalled()).candles.at(-1).close;
    await pick(page, 'bb', { period: 5 });
    const [upper, basis, lower] = ['upper', 'basis', 'lower'].map((k) => lineData(page, k));
    const last = async (p) => (await p).at(-1).value;
    expect(await last(basis)).toBe(price);
    expect(await last(upper)).toBe(price); // no spread any more
    expect(await last(lower)).toBe(price);
    await pick(page, 'sma', { period: 5 });
    expect((await lineData(page, 'sma')).at(-1).value).toBe(price);
  });
});

test.describe('2000 bars with every indicator', () => {
  for (const [kind, info] of Object.entries(KINDS)) {
    test(`${info.label} with period 200 matches the reference`, async ({ page }) => {
      await open(page);
      await pick(page, kind, { scenario: 'long', source: 'ohlc4', period: 200 });
      await expectLines(page, kind, SCENARIOS.long(), { period: 200 }, 'ohlc4');
    });
  }
});

test.describe('injected bug is caught for every indicator', () => {
  for (const [kind, info] of Object.entries(KINDS)) {
    test(`${info.label}: off-by-one period is detected`, async ({ page }) => {
      await open(page, '?bug=offbyone');
      await pick(page, kind);
      const want = info.ref(NORMAL, { period: info.period }, 'close');
      const mismatches = [];
      for (const key of info.keys) {
        try { expectSeriesClose(await lineData(page, key), want[key]); } catch (e) { mismatches.push(e.message); }
      }
      expect(mismatches.length).toBeGreaterThan(0);
    });
  }
});
