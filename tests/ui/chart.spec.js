import { test, expect, open, smaData, candleData, text, probeSmaLine, expectLineAt } from './fixtures.js';
import { SOURCES } from '../../src/sma.js';
import { SCENARIOS } from '../../src/scenarios.js';
import { sanitizeCandles } from '../../src/sanitize.js';
import { refSMA, expectSeriesClose, expectedBars } from '../unit/helpers.js';

const normal = SCENARIOS.normal();
const fmt = (n) => n.toFixed(2);

test.describe('initial render', () => {
  test('chart, candles and SMA line are drawn', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('chart').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('status')).toHaveText('OK');
    await expect(page.getByTestId('bar-count')).toHaveText('60');
    expect(await candleData(page)).toHaveLength(60);
    expect(await smaData(page)).toHaveLength(41); // 60 bars, period 20
  });

  test('candle data on the chart equals the generated data', async ({ page }) => {
    await open(page);
    const onChart = await candleData(page);
    expect(onChart.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })))
      .toEqual(normal.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  });
});

test.describe('SMA settings rebuild the line', () => {
  for (const source of SOURCES) {
    test(`source ${source} matches the reference`, async ({ page }) => {
      await open(page);
      await page.getByTestId('source').selectOption(source);
      expectSeriesClose(await smaData(page), refSMA(normal, 20, source));
    });
  }

  for (const period of [1, 5, 20, 59, 60, 61]) {
    test(`period ${period} matches the reference`, async ({ page }) => {
      await open(page);
      await page.getByTestId('period').fill(String(period));
      const expected = period > 60 ? [] : refSMA(normal, period, 'close');
      expectSeriesClose(await smaData(page), expected);
      await expect(page.getByTestId('status')).toHaveText('OK');
    });
  }

  test('changing source and period together', async ({ page }) => {
    await open(page);
    await page.getByTestId('source').selectOption('ohlc4');
    await page.getByTestId('period').fill('7');
    expectSeriesClose(await smaData(page), refSMA(normal, 7, 'ohlc4'));
  });

  for (const bad of ['0', '-3', '1.5', '']) {
    test(`invalid period "${bad}" shows an error and keeps the old line`, async ({ page }) => {
      await open(page);
      const before = await smaData(page);
      await page.getByTestId('period').fill(bad);
      await expect(page.getByTestId('status')).toContainText('Invalid period');
      expect(await smaData(page)).toEqual(before);
    });
  }
});

test.describe('price display', () => {
  test('legend shows the last close and last SMA', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('last-close')).toHaveText(fmt(normal.at(-1).close));
    await expect(page.getByTestId('last-sma')).toHaveText(fmt(refSMA(normal, 20, 'close').at(-1).value));
  });

  test('legend SMA follows the settings', async ({ page }) => {
    await open(page);
    await page.getByTestId('source').selectOption('volume');
    await page.getByTestId('period').fill('10');
    await expect(page.getByTestId('last-sma')).toHaveText(fmt(refSMA(normal, 10, 'volume').at(-1).value));
  });
});

test.describe('visual check on the real canvas', () => {
  test('SMA line is drawn exactly where its last value should be', async ({ page }) => {
    await open(page);
    await expectLineAt(page);
  });

  test('the line moves when the source changes', async ({ page }) => {
    await open(page);
    await expectLineAt(page);
    const a = await probeSmaLine(page);
    await page.getByTestId('source').selectOption('low');
    await expectLineAt(page);
    const b = await probeSmaLine(page);
    const mean = (ys) => ys.reduce((x, y) => x + y, 0) / ys.length;
    expect(mean(b.ys)).toBeGreaterThan(mean(a.ys)); // SMA(low) is below SMA(close): larger y
  });

  test('the whole line is drawn: orange pixels exist across the chart', async ({ page }) => {
    await open(page);
    const count = await page.evaluate(() => {
      const c = window.__app.chart.takeScreenshot();
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 120 && d[i + 1] < 190 && d[i + 2] < 80) n++;
      return n;
    });
    expect(count).toBeGreaterThan(300);
  });
});

test.describe('realtime updates', () => {
  const expectedAfter = (steps) => expectedBars(60, steps);

  test('one tick opens a new bar, further ticks only update it', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__app.step());
    await expect(page.getByTestId('bar-count')).toHaveText('61');
    const c1 = (await candleData(page)).at(-1);
    await page.evaluate(() => window.__app.step());
    await expect(page.getByTestId('bar-count')).toHaveText('61');
    const c2 = (await candleData(page)).at(-1);
    expect(c2.time).toBe(c1.time);
    expect(c2.close).not.toBe(c1.close);
  });

  for (const steps of [1, 2, 3, 5, 6, 12]) {
    test(`SMA is correct after ${steps} ticks`, async ({ page }) => {
      await open(page);
      await page.getByTestId('source').selectOption('hlc3');
      await page.getByTestId('period').fill('10');
      for (let i = 0; i < steps; i++) await page.evaluate(() => window.__app.step());
      const bars = expectedAfter(steps);
      expectSeriesClose(await smaData(page), refSMA(bars, 10, 'hlc3'));
      expect((await candleData(page)).at(-1).close).toBeCloseTo(bars.at(-1).close, 6);
      await expect(page.getByTestId('last-sma')).toHaveText(fmt(refSMA(bars, 10, 'hlc3').at(-1).value));
    });
  }

  test('start button streams new bars, stop button stops them', async ({ page }) => {
    await open(page);
    await page.getByTestId('start').click();
    await expect.poll(async () => Number(await text(page, 'bar-count')), { timeout: 8000 }).toBeGreaterThan(60);
    await page.getByTestId('stop').click();
    const frozen = await text(page, 'bar-count');
    const frozenClose = await text(page, 'last-close');
    await page.waitForTimeout(700);
    expect(await text(page, 'bar-count')).toBe(frozen);
    expect(await text(page, 'last-close')).toBe(frozenClose);
  });

  test('streaming is refused for non-normal data', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('negative');
    await page.getByTestId('start').click();
    await expect(page.getByTestId('status')).toContainText('Streaming is available');
  });
});

test.describe('strange data', () => {
  const cases = {
    negative: { bars: 60, status: 'OK' },
    huge: { bars: 60, status: 'OK' },
    overflow: { bars: 59, status: 'out-of-range' },
    nan: { bars: 58, status: 'invalid' },
    inconsistent: { bars: 56, status: 'inconsistent' },
    duplicates: { bars: 60, status: 'duplicate' },
    unordered: { bars: 60, status: 'unordered' },
    empty: { bars: 0, status: 'no data' },
  };

  for (const [name, { bars, status }] of Object.entries(cases)) {
    test(`${name}: page survives, status is clear, SMA is correct`, async ({ page }) => {
      await open(page);
      await page.getByTestId('scenario').selectOption(name);
      await expect(page.getByTestId('bar-count')).toHaveText(String(bars));
      await expect(page.getByTestId('status')).toContainText(status);
      const expected = sanitizeCandles(SCENARIOS[name]()).candles;
      expect(await candleData(page)).toHaveLength(bars);
      expectSeriesClose(await smaData(page), refSMA(expected, 20, 'close'));
    });
  }

  test('negative prices are shown with a minus sign in the legend', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('negative');
    expect(Number(await text(page, 'last-close'))).toBeLessThan(0);
    expect(Number(await text(page, 'last-sma'))).toBeLessThan(0);
  });

  test('huge prices: legend matches, line is still on the canvas', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('huge');
    const expected = sanitizeCandles(SCENARIOS.huge()).candles;
    await expect(page.getByTestId('last-close')).toHaveText(fmt(expected.at(-1).close));
    const probe = await probeSmaLine(page);
    expect(probe.expectedY).toBeGreaterThan(0);
    expect(probe.expectedY).toBeLessThan(probe.height);
    await expectLineAt(page);
  });

  test('empty data: legend shows dashes, switching back restores the chart', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('empty');
    await expect(page.getByTestId('last-close')).toHaveText('—');
    await expect(page.getByTestId('last-sma')).toHaveText('—');
    await page.getByTestId('scenario').selectOption('normal');
    await expect(page.getByTestId('bar-count')).toHaveText('60');
    expect(await smaData(page)).toHaveLength(41);
  });
});

test.describe('the tests really catch a broken SMA', () => {
  test('injected off-by-one bug is detected by the data check', async ({ page }) => {
    await open(page, '?bug=offbyone');
    const actual = await smaData(page);
    expect(() => expectSeriesClose(actual, refSMA(normal, 20, 'close'))).toThrow();
  });

  test('injected bug is detected by the legend check', async ({ page }) => {
    await open(page, '?bug=offbyone');
    await expect(page.getByTestId('last-sma')).not.toHaveText(fmt(refSMA(normal, 20, 'close').at(-1).value));
  });
});
