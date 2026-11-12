import { test, expect, only, INDICATOR_KINDS, LEGEND_VALUE, expectLineAt } from './fixtures.js';
import { pretendExchanges, openLive } from './exchanges.js';
import { computeIndicator, INDICATORS } from '../../src/indicators.js';
import { compareSeries } from '../../checks/reference.js';

// The four indicators can be on at the same time, each with its own settings.
const LINE_KEYS = { sma: ['sma'], ema: ['ema'], bb: ['basis', 'upper', 'lower'], rsi: ['rsi'] };
const DEFAULT_PERIOD = { sma: 20, ema: 20, bb: 20, rsi: 14 };

// one after another, as a person clicks
const switchOn = async (page, ...kinds) => { for (const k of kinds) await page.getByTestId(`ind-${k}`).setChecked(true); };
const switchOff = async (page, ...kinds) => { for (const k of kinds) await page.getByTestId(`ind-${k}`).setChecked(false); };
const lineData = (page, key) => page.evaluate((k) => window.__app.lineData(k), key);
const lineKeys = (page) => page.evaluate(() => Object.keys(window.__app.lineSeries()));
const paneCount = (page) => page.evaluate(() => window.__app.chart.panes().length);
const snapshotAll = async (page) => Object.fromEntries(await Promise.all(Object.values(LINE_KEYS).flat().map(async (k) => [k, await lineData(page, k)])));

// every indicator that is on shows exactly what the reference calculates from the bars on the chart and its own settings
async function expectEveryLineRight(page, label = '') {
  const { st, candles } = await page.evaluate(() => ({ st: window.__app.state(), candles: window.__app.rawCandleData() }));
  for (const kind of st.enabled) {
    const cfg = st.indicators[kind];
    const want = computeIndicator(kind, candles, { period: cfg.period, mult: cfg.mult, start: cfg.start }, cfg.source);
    for (const key of LINE_KEYS[kind]) {
      const got = await lineData(page, key);
      expect(() => compareSeries(got, want[key], 6), `${label} ${kind}/${key} (${JSON.stringify(cfg)})`).not.toThrow();
      expect(got.length, `${label} ${kind}/${key}`).toBeGreaterThan(0);
    }
  }
}

test.beforeEach(async ({ page }) => {
  await pretendExchanges(page);
  await openLive(page);
});

test.describe('switching indicators on and off', () => {
  test('at the start only the SMA is on, with its default settings', async ({ page }) => {
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`ind-${kind}`)).toBeChecked({ checked: kind === 'sma' });
    expect(await lineKeys(page)).toEqual(['sma']);
    expect(await paneCount(page)).toBe(1);
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`period-${kind}`)).toHaveValue(String(DEFAULT_PERIOD[kind]));
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`source-${kind}`)).toHaveValue('close');
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`legend-${kind}`)).toBeVisible({ visible: kind === 'sma' });
  });

  test('all four at once: every line is there, in its own colour, in its own pane, and right', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    expect(await lineKeys(page)).toEqual(['sma', 'ema', 'basis', 'upper', 'lower', 'rsi']);
    expect(await paneCount(page)).toBe(2);
    await expect(page.getByTestId('status')).toHaveText(/^Live BTCUSDT 1m/);
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`legend-${kind}`)).toBeVisible();
    await expectEveryLineRight(page, 'all four');
    const colors = await page.evaluate(() => Object.values(window.__app.lineSeries()).map((s) => s.options().color));
    expect(new Set(colors).size).toBe(6);                       // six lines, six colours: nothing is confused with anything
  });

  test('every line is drawn at the right height on the canvas, all four on', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    // with the same period and source the SMA and the middle band are one and the same line, and one hides the other
    await page.getByTestId('period-bb').fill('27');
    for (const key of ['sma', 'ema', 'basis', 'upper', 'lower', 'rsi']) await expectLineAt(page, { key });
  });

  test('the legend shows the last value of each, with its own label', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    for (const [kind, key] of [['sma', 'sma'], ['ema', 'ema'], ['bb', 'basis'], ['rsi', 'rsi']]) {
      const last = (await lineData(page, key)).at(-1).value;
      await expect(page.getByTestId(LEGEND_VALUE[kind])).toHaveText(last.toFixed(2));
      await expect(page.getByTestId(`legend-label-${kind}`)).toHaveText(INDICATORS[kind].label);
    }
    for (const key of ['upper', 'lower']) await expect(page.getByTestId(`last-bb-${key}`)).toHaveText((await lineData(page, key)).at(-1).value.toFixed(2));
  });

  // all 16 combinations of on and off
  for (let mask = 0; mask < 16; mask++) {
    const on = INDICATOR_KINDS.filter((_, i) => mask & (1 << i));
    test(`on: ${on.length ? on.join(' + ') : 'nothing'}`, async ({ page }) => {
      await switchOff(page, 'sma');
      await switchOn(page, ...on);
      expect(await lineKeys(page)).toEqual(on.flatMap((k) => LINE_KEYS[k]));
      expect(await paneCount(page)).toBe(on.includes('rsi') ? 2 : 1);
      for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`legend-${kind}`)).toBeVisible({ visible: on.includes(kind) });
      await expectEveryLineRight(page, on.join('+'));
      await expect(page.getByTestId('status')).toHaveText(/^Live BTCUSDT 1m/);
    });
  }

  test('switching one off takes away only its lines, its legend and (RSI) its pane', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    const before = await snapshotAll(page);
    await switchOff(page, 'rsi');
    expect(await paneCount(page)).toBe(1);
    expect(await lineKeys(page)).toEqual(['sma', 'ema', 'basis', 'upper', 'lower']);
    await expect(page.getByTestId('legend-rsi')).toBeHidden();
    const after = await snapshotAll(page);
    for (const key of ['sma', 'ema', 'basis', 'upper', 'lower']) expect(after[key], key).toEqual(before[key]);   // the others did not change at all
    await switchOff(page, 'bb');
    expect(await lineKeys(page)).toEqual(['sma', 'ema']);
    await expect(page.getByTestId('legend-bb')).toBeHidden();
    await switchOn(page, 'rsi');
    expect(await paneCount(page)).toBe(2);
    await expect(page.getByTestId('legend-rsi')).toBeVisible();
  });

  test('switching everything off leaves a clean chart of candles, and everything can come back', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    await switchOff(page, 'sma', 'ema', 'bb', 'rsi');
    expect(await lineKeys(page)).toEqual([]);
    expect(await paneCount(page)).toBe(1);
    for (const kind of INDICATOR_KINDS) await expect(page.getByTestId(`legend-${kind}`)).toBeHidden();
    await expect(page.getByTestId('bar-count')).not.toHaveText('0');
    await expect(page.getByTestId('settle-note')).toBeHidden();
    await switchOn(page, 'sma', 'ema', 'bb', 'rsi');
    await expectEveryLineRight(page, 'back');
  });
});

test.describe('each indicator has its own settings', () => {
  const settings = async (page) => {
    await page.getByTestId('period-sma').fill('5');     await page.getByTestId('source-sma').selectOption('hl2');
    await page.getByTestId('period-ema').fill('9');     await page.getByTestId('source-ema').selectOption('volume');
    await page.getByTestId('ema-start').selectOption('sma');
    await page.getByTestId('period-bb').fill('10');     await page.getByTestId('source-bb').selectOption('open');
    await page.getByTestId('mult').fill('3');
    await page.getByTestId('period-rsi').fill('7');     await page.getByTestId('source-rsi').selectOption('low');
  };

  test('four different periods, sources, start and multiplier at once: each line is right for its own', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    await settings(page);
    const st = await page.evaluate(() => window.__app.state().indicators);
    expect(st.sma).toMatchObject({ period: 5, source: 'hl2' });
    expect(st.ema).toMatchObject({ period: 9, source: 'volume', start: 'sma' });
    expect(st.bb).toMatchObject({ period: 10, source: 'open', mult: 3 });
    expect(st.rsi).toMatchObject({ period: 7, source: 'low' });
    await expectEveryLineRight(page, 'own settings');
  });

  test('changing one indicator changes only its lines', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    const before = await snapshotAll(page);
    await page.getByTestId('period-sma').fill('7');
    await expect.poll(async () => (await lineData(page, 'sma')).length).not.toBe(before.sma.length);
    const after = await snapshotAll(page);
    for (const key of ['ema', 'basis', 'upper', 'lower', 'rsi']) expect(after[key], key).toEqual(before[key]);
    await page.getByTestId('source-ema').selectOption('high');
    const after2 = await snapshotAll(page);
    for (const key of ['sma', 'basis', 'upper', 'lower', 'rsi']) expect(after2[key], key).toEqual(after[key]);
    expect(after2.ema).not.toEqual(after.ema);
    await page.getByTestId('mult').fill('2.5');
    const after3 = await snapshotAll(page);
    for (const key of ['sma', 'ema', 'basis', 'rsi']) expect(after3[key], key).toEqual(after2[key]);   // the middle line does not depend on the multiplier
    expect(after3.upper).not.toEqual(after2.upper);
    await expectEveryLineRight(page, 'after changes');
  });

  test('settings survive switching the indicator off and on', async ({ page }) => {
    await page.getByTestId('period-ema').fill('9');
    await page.getByTestId('ema-start').selectOption('sma');
    await switchOn(page, 'ema');
    const before = await lineData(page, 'ema');
    await switchOff(page, 'ema');
    await switchOn(page, 'ema');
    await expect(page.getByTestId('period-ema')).toHaveValue('9');
    await expect(page.getByTestId('ema-start')).toHaveValue('sma');
    expect(await lineData(page, 'ema')).toEqual(before);
  });

  test('an indicator that is off can be set up first and switched on afterwards', async ({ page }) => {
    await page.getByTestId('period-rsi').fill('5');
    await page.getByTestId('source-rsi').selectOption('hlc3');
    expect(await lineKeys(page)).toEqual(['sma']);
    await switchOn(page, 'rsi');
    await expectEveryLineRight(page, 'set up first');
  });

  test('a wrong period is refused for that indicator only: the message names it, its lines and the others stay', async ({ page }) => {
    await switchOn(page, 'ema', 'bb', 'rsi');
    const before = await snapshotAll(page);
    await page.getByTestId('period-ema').fill('0');
    await expect(page.getByTestId('status')).toHaveText(/Invalid period \(EMA\)/);
    await expect(page.getByTestId('period-ema')).toHaveValue('20');   // back to what works
    expect(await snapshotAll(page)).toEqual(before);
    await page.getByTestId('mult').fill('-1');
    await expect(page.getByTestId('status')).toHaveText(/Invalid multiplier \(BB\)/);
    expect(await snapshotAll(page)).toEqual(before);
  });

  test('a period longer than the history empties that line only, and says so for that indicator', async ({ page }) => {
    await switchOn(page, 'ema', 'rsi');
    const bars = Number(await page.getByTestId('bar-count').textContent());
    await page.getByTestId('period-sma').fill(String(bars + 5));
    await expect(page.getByTestId('settle-note-sma')).toContainText('has no values yet');
    expect(await lineData(page, 'sma')).toEqual([]);
    expect((await lineData(page, 'ema')).length).toBeGreaterThan(100);
    expect((await lineData(page, 'rsi')).length).toBeGreaterThan(100);
    await expect(page.getByTestId('settle-note-ema')).toHaveCount(0);   // the others have no complaint
  });

  test('two notes at once: each indicator that has not settled says so on its own line', async ({ page }) => {
    await switchOn(page, 'ema', 'rsi');
    await page.getByTestId('period-ema').fill('400');   // 500 bars are not enough for 400 to settle
    await page.getByTestId('period-rsi').fill('300');
    await expect(page.getByTestId('settle-note-ema')).toContainText('EMA(400) has not settled');
    await expect(page.getByTestId('settle-note-rsi')).toContainText('RSI(300) has not settled');
    await switchOff(page, 'rsi');
    await expect(page.getByTestId('settle-note-rsi')).toHaveCount(0);
    await expect(page.getByTestId('settle-note-ema')).toBeVisible();
  });
});

test.describe('the stream with all four on', () => {
  test('a trade updates every indicator, and each stays equal to the reference', async ({ page }) => {
    const mock = await pretendExchanges(page);
    await openLive(page);
    await switchOn(page, 'ema', 'bb', 'rsi');
    await page.getByTestId('period-sma').fill('9');
    await page.getByTestId('source-rsi').selectOption('hl2');
    const before = await snapshotAll(page);
    mock.tick('BTCUSDT', 74_000);
    await expect(page.getByTestId('last-close')).toHaveText('74000.00');
    const after = await snapshotAll(page);
    for (const key of Object.keys(before)) expect(after[key].at(-1).value, key).not.toBe(before[key].at(-1).value);
    await expectEveryLineRight(page, 'after a tick');
    for (let i = 1; i <= 6; i++) mock.tick('BTCUSDT', 74_000 + i * 15);
    await expectEveryLineRight(page, 'after more ticks');
  });

  test('a new bar extends every line by one, and the lines are still right', async ({ page }) => {
    const mock = await pretendExchanges(page);
    await openLive(page);
    await switchOn(page, 'ema', 'bb', 'rsi');
    const before = await snapshotAll(page);
    const last = (await page.evaluate(() => window.__app.rawCandleData().at(-1).time));
    mock.tick('BTCUSDT', 73_700, { time: last + 60 });
    await expect(page.getByTestId('bar-count')).toHaveText(String(Number(await page.getByTestId('bar-count').textContent())));
    await expect.poll(async () => (await lineData(page, 'rsi')).length).toBe(before.rsi.length + 1);
    for (const key of Object.keys(before)) expect((await lineData(page, key)).length, key).toBe(before[key].length + 1);
    await expectEveryLineRight(page, 'new bar');
  });

  test('the zoom is kept when an indicator is switched on or off', async ({ page }) => {
    await expect.poll(async () => {
      await page.evaluate(() => window.__app.chart.timeScale().setVisibleLogicalRange({ from: 440, to: 500 }));
      const r = await page.evaluate(() => window.__app.chart.timeScale().getVisibleLogicalRange());
      return r.to - r.from;
    }).toBeLessThan(80);
    const range = () => page.evaluate(() => window.__app.chart.timeScale().getVisibleLogicalRange());
    const zoomed = await range();
    await switchOn(page, 'ema', 'bb', 'rsi');
    const now = await range();
    expect(now.from).toBeCloseTo(zoomed.from, 3);
    expect(now.to).toBeCloseTo(zoomed.to, 3);
    await switchOff(page, 'ema', 'rsi');
    const again = await range();
    expect(again.from).toBeCloseTo(zoomed.from, 3);
  });

  test('an RSI below 1 is still read with 2 decimals, not with the many a small price would need', async ({ page }) => {
    // a long fall with a rare tiny rise: the RSI stays near 0.2
    let previous = 100;
    const falling = Array.from({ length: 300 }, (_, i) => {
      const close = previous * (i % 5 === 0 && i > 0 ? 1.0001 : 0.99);
      const c = { time: 1_699_999_980 + 60 * i, open: previous, close, high: Math.max(previous, close) * 1.0001, low: Math.min(previous, close) * 0.9999, volume: 10 };
      previous = close;
      return c;
    });
    await pretendExchanges(page, { candles: falling });
    await openLive(page);
    await switchOn(page, 'rsi');
    const last = (await lineData(page, 'rsi')).at(-1).value;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(1);                                              // the premise: a value that would tempt more decimals
    await expect(page.getByTestId('last-rsi')).toHaveText(last.toFixed(2));
    expect(await page.evaluate(() => window.__app.lineSeries().rsi.options().priceFormat.precision)).toBe(2);
  });

  test('each indicator is read with its own number of decimals: RSI with 2, the others with the price', async ({ page }) => {
    // a coin worth a hundred-thousandth of a dollar: prices need 8 decimals, the RSI (0-100) does not
    const cheap = Array.from({ length: 300 }, (_, i) => { const p = 0.00001234 + (Math.sin(i / 9) * 2e-7) + i * 1e-9; return { time: 1_699_999_980 + 60 * i, open: p, high: p + 1e-8, low: p - 1e-8, close: p + 5e-9, volume: 10 }; });
    await pretendExchanges(page, { candles: cheap });
    await openLive(page);
    await switchOn(page, 'ema', 'bb', 'rsi');
    await expect(page.getByTestId('last-sma')).toHaveText(/^0\.0000\d{4,}$/);
    await expect(page.getByTestId('last-ema')).toHaveText(/^0\.0000\d{4,}$/);
    await expect(page.getByTestId('last-bb-upper')).toHaveText(/^0\.0000\d{4,}$/);
    await expect(page.getByTestId('last-rsi')).toHaveText(/^\d{1,3}\.\d{2}$/);
    const precision = await page.evaluate(() => Object.fromEntries(Object.entries(window.__app.lineSeries()).map(([k, s]) => [k, s.options().priceFormat.precision])));
    expect(precision.rsi).toBe(2);
    expect(precision.sma).toBeGreaterThanOrEqual(8);
    expect(new Set([precision.upper, precision.basis, precision.lower]).size).toBe(1);
  });
});
