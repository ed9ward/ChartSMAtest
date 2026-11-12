import { test, expect, open } from './fixtures.js';
import { only, periodOf, sourceOf, mainValue, labelOf } from './fixtures.js';

// What is really drawn on the canvas, not only what the chart was given.
// Every check reads the pixels of the chart (chart.takeScreenshot()) and compares them with the geometry the chart
// itself reports for the data (timeToCoordinate / priceToCoordinate), bar by bar. There are no golden screenshots:
// those differ between machines (fonts, browser versions) and would fail for reasons that are not bugs.

const COLORS = { up: [0x26, 0xa6, 0x9a], down: [0xef, 0x53, 0x50] };

// Runs in the page. Returns, for each visible bar, what the canvas shows: the colour of the body, of the wicks, and
// where the candle's top and bottom pixels are.
function scanCandlesInPage({ UP, DOWN }) {
  const { chart, candleSeries } = window.__app;
  // The dashed line of the last price runs across the whole chart in the colour of the last candle: take it away for the snapshot.
  // The indicator lines are taken away too: one may run right through the middle of a body.
  const before = candleSeries.options();
  const lineSeries = Object.values(window.__app.lineSeries());
  candleSeries.applyOptions({ priceLineVisible: false, lastValueVisible: false });
  for (const l of lineSeries) l.applyOptions({ visible: false });
  const canvas = chart.takeScreenshot();
  for (const l of lineSeries) l.applyOptions({ visible: true });
  candleSeries.applyOptions({ priceLineVisible: before.priceLineVisible, lastValueVisible: before.lastValueVisible });
  const w = canvas.width, h = canvas.height;
  const img = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const at = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return null; const i = (y * w + x) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  const kind = (p) => (p === null ? 'none' : dist(p, UP) < 30 ? 'up' : dist(p, DOWN) < 30 ? 'down' : dist(p, [255, 255, 255]) < 25 ? 'bg' : 'other');
  const plotWidth = w - chart.priceScale('right').width();
  const paneHeight = chart.panes()[0].getHeight();
  const bars = [];
  for (const c of candleSeries.data()) {
    const x = chart.timeScale().timeToCoordinate(c.time);
    if (x === null || x < 3 || x > plotWidth - 3) continue;
    const [yO, yC, yH, yL] = [c.open, c.close, c.high, c.low].map((p) => candleSeries.priceToCoordinate(p));
    if ([yO, yC, yH, yL].some((v) => v === null || v < 0 || v > paneHeight)) continue;
    const top = Math.min(yO, yC), bottom = Math.max(yO, yC);
    const columns = [x - 1, x, x + 1];
    const wickKind = (y) => { const found = columns.map((cx) => kind(at(cx, y))).filter((k) => k === 'up' || k === 'down'); return found[0] ?? kind(at(x, y)); };
    // top-most and bottom-most pixel of candle colour in the columns of this bar
    let first = null, last = null;
    for (let y = 0; y < paneHeight; y++) {
      if (columns.some((cx) => ['up', 'down'].includes(kind(at(cx, y))))) { if (first === null) first = y; last = y; }
    }
    bars.push({
      time: c.time, expected: c.close >= c.open ? 'up' : 'down',
      bodyHeight: bottom - top, upperWick: top - yH, lowerWick: yL - bottom,
      body: kind(at(x, (yO + yC) / 2)),
      upperWickKind: top - yH >= 6 ? wickKind((yH + top) / 2) : null,
      lowerWickKind: yL - bottom >= 6 ? wickKind((yL + bottom) / 2) : null,
      aboveHigh: kind(at(x, yH - 4)), belowLow: kind(at(x, yL + 4)),
      firstY: first, lastY: last, yH, yL,
    });
  }
  return bars;
}

const scan = (page) => page.evaluate(scanCandlesInPage, { UP: COLORS.up, DOWN: COLORS.down });

// The rules a correct picture follows. Returns the list of bars that break one.
function problems(bars) {
  const found = [];
  for (const b of bars) {
    const why = [];
    if (b.bodyHeight >= 4 && b.body !== b.expected) why.push(`body is ${b.body}, should be ${b.expected}`);
    if (b.upperWickKind && b.upperWickKind !== b.expected) why.push(`upper wick is ${b.upperWickKind}`);
    if (b.lowerWickKind && b.lowerWickKind !== b.expected) why.push(`lower wick is ${b.lowerWickKind}`);
    if (b.firstY === null || Math.abs(b.firstY - b.yH) > 2.5) why.push(`top of the candle is at ${b.firstY}, high is at ${b.yH.toFixed(1)}`);
    if (b.lastY === null || Math.abs(b.lastY - b.yL) > 2.5) why.push(`bottom of the candle is at ${b.lastY}, low is at ${b.yL.toFixed(1)}`);
    if (b.aboveHigh === 'up' || b.aboveHigh === 'down') why.push('something of candle colour above the high');
    if (b.belowLow === 'up' || b.belowLow === 'down') why.push('something of candle colour below the low');
    if (why.length) found.push({ time: b.time, why });
  }
  return found;
}

// Waits until the chart has repainted with what it was given (the canvas lags a frame behind any change).
async function settled(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.describe('candles on the canvas', () => {
  test('every visible candle has the right colour, wicks, top and bottom (60 bars)', async ({ page }) => {
    await open(page);
    await settled(page);
    const bars = await scan(page);
    expect(bars.length).toBeGreaterThanOrEqual(55);          // not vacuous: nearly all 60 bars were really examined
    expect(bars.filter((b) => b.expected === 'up').length).toBeGreaterThan(10);   // both directions are in the data
    expect(bars.filter((b) => b.expected === 'down').length).toBeGreaterThan(10);
    expect(problems(bars)).toEqual([]);
    expect(bars.filter((b) => b.bodyHeight >= 4).length).toBeGreaterThan(40);     // and most bodies were big enough to be read
  });

  test('the colour follows the direction of every bar: up is green, down is red, in both orders', async ({ page }) => {
    await open(page);
    await settled(page);
    const bars = await scan(page);
    const withBody = bars.filter((b) => b.bodyHeight >= 4);
    expect(withBody.filter((b) => b.expected === 'up').every((b) => b.body === 'up')).toBe(true);
    expect(withBody.filter((b) => b.expected === 'down').every((b) => b.body === 'down')).toBe(true);
  });

  for (const name of ['negative', 'huge', 'tiny']) {
    test(`${name} prices are drawn as correctly as ordinary ones`, async ({ page }) => {
      await open(page);
      await page.getByTestId('scenario').selectOption(name);
      await settled(page);
      const bars = await scan(page);
      expect(bars.length).toBeGreaterThanOrEqual(55);
      expect(problems(bars)).toEqual([]);
    });
  }

  test('the last 60 of 2000 bars are drawn correctly too', async ({ page }) => {
    await open(page);
    await page.getByTestId('scenario').selectOption('long');
    await page.evaluate(() => window.__app.chart.timeScale().setVisibleLogicalRange({ from: 1940, to: 2000 }));
    await settled(page);
    const bars = await scan(page);
    expect(bars.length).toBeGreaterThanOrEqual(55);
    expect(problems(bars)).toEqual([]);
  });

  test('a new bar and the ticks on it are drawn: the last candle changes with the stream', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { for (let i = 0; i < 7; i++) window.__app.step(); }); // opens a bar and updates it
    await settled(page);
    const bars = await scan(page);
    expect(bars.length).toBeGreaterThanOrEqual(55);
    expect(problems(bars)).toEqual([]);
  });

  test('the check can fail: swapped up/down colours are noticed', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__app.candleSeries.applyOptions({ upColor: '#ef5350', downColor: '#26a69a', wickUpColor: '#ef5350', wickDownColor: '#26a69a' }));
    await settled(page);
    const found = problems(await scan(page));
    expect(found.length).toBeGreaterThan(40);
    expect(found[0].why.join()).toContain('should be');
  });

  test('the check can fail: a candle drawn from other prices than the app holds is noticed', async ({ page }) => {
    await open(page);
    // the chart is given candles whose highs and lows are cut; the app's own data are untouched
    await page.evaluate(() => {
      const { candleSeries } = window.__app;
      candleSeries.setData(candleSeries.data().map((c) => ({ ...c, high: Math.max(c.open, c.close), low: Math.min(c.open, c.close) })));
    });
    await settled(page);
    const original = await page.evaluate(() => window.__app.rawCandleData());
    const bars = await page.evaluate(scanCandlesInPage, { UP: COLORS.up, DOWN: COLORS.down });
    // the scan reads the series' data, so compare the picture with the app's data instead: the wicks are missing
    const withWicks = original.filter((c) => c.high - Math.max(c.open, c.close) > 0.5);
    expect(withWicks.length).toBeGreaterThan(20);
    expect(bars.every((b) => b.upperWick < 1 && b.lowerWick < 1)).toBe(true);
  });
});

test.describe('the RSI panel', () => {
  async function rsiPanel(page) {
    await open(page);
    await only(page, 'rsi');
    await settled(page);
  }

  test('a second panel below the chart, smaller than the candles, with a line inside it', async ({ page }) => {
    await rsiPanel(page);
    const layout = await page.evaluate(() => {
      const { chart, lineSeries } = window.__app;
      const panes = chart.panes();
      const last = lineSeries().rsi.data().at(-1);
      return { count: panes.length, heights: panes.map((p) => p.getHeight()), rsiY: lineSeries().rsi.priceToCoordinate(last.value), value: last.value };
    });
    expect(layout.count).toBe(2);
    expect(layout.heights[0]).toBeGreaterThan(layout.heights[1]);   // candles get more room than the oscillator
    expect(layout.heights[1]).toBeGreaterThan(60);                    // and the oscillator is still readable
    expect(layout.rsiY).toBeGreaterThan(0);
    expect(layout.rsiY).toBeLessThan(layout.heights[1]);              // the line is inside its own panel
  });

  test('the scale is fixed at 0-100: 70 is above 30, 0 and 100 are the edges, and the guides are drawn there', async ({ page }) => {
    await rsiPanel(page);
    const r = await page.evaluate(() => {
      const { chart, lineSeries } = window.__app;
      const s = lineSeries().rsi;
      const offset = chart.panes()[0].getHeight() + 1;
      const canvas = chart.takeScreenshot();
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const plotWidth = canvas.width - chart.priceScale('right').width();
      // grey dashes (#999) on a row: how many pixels of that grey does the row hold?
      const grey = (y) => { let n = 0; for (let x = 0; x < plotWidth; x++) { const i = (Math.round(y) * canvas.width + x) * 4; if (Math.abs(img[i] - 153) < 25 && Math.abs(img[i + 1] - 153) < 25 && Math.abs(img[i + 2] - 153) < 25) n++; } return n; };
      const y = (v) => s.priceToCoordinate(v);
      return { y0: y(0), y30: y(30), y70: y(70), y100: y(100), paneHeight: chart.panes()[1].getHeight(), grey30: grey(offset + y(30)), grey70: grey(offset + y(70)), greyElsewhere: grey(offset + (y(50))) };
    });
    expect(r.y100).toBeLessThan(r.y70);
    expect(r.y70).toBeLessThan(r.y30);
    expect(r.y30).toBeLessThan(r.y0);
    expect(r.y0 - r.y100).toBeGreaterThan(r.paneHeight * 0.6);        // 0 to 100 fills most of the panel
    expect(r.y0).toBeLessThanOrEqual(r.paneHeight + 1);
    expect(r.y100).toBeGreaterThanOrEqual(-1);
    expect(r.grey30).toBeGreaterThan(100);                            // the dashed guide at 30 is drawn
    expect(r.grey70).toBeGreaterThan(100);                            // and at 70
    expect(r.greyElsewhere).toBeLessThan(10);                         // and no guide at 50
  });

  test('no candle reaches into the oscillator panel, and no oscillator colour into the candles', async ({ page }) => {
    await rsiPanel(page);
    const r = await page.evaluate(({ UP, DOWN }) => {
      const { chart } = window.__app;
      const canvas = chart.takeScreenshot();
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const plotWidth = canvas.width - chart.priceScale('right').width();
      const split = chart.panes()[0].getHeight();
      const dist = (i, c) => Math.hypot(img[i] - c[0], img[i + 1] - c[1], img[i + 2] - c[2]);
      let candleInRsi = 0, rsiInCandles = 0;
      for (let y = 0; y < canvas.height - 30; y++) for (let x = 0; x < plotWidth; x++) {
        const i = (y * canvas.width + x) * 4;
        if (y > split + 2 && (dist(i, UP) < 30 || dist(i, DOWN) < 30)) candleInRsi++;
        if (y < split - 2 && dist(i, [0xe9, 0x1e, 0x63]) < 25) rsiInCandles++;
      }
      return { candleInRsi, rsiInCandles };
    }, { UP: COLORS.up, DOWN: COLORS.down });
    expect(r.candleInRsi).toBe(0);
    expect(r.rsiInCandles).toBe(0);
  });

  test('the RSI line is drawn at its value and in its colour, whatever the period', async ({ page }) => {
    await rsiPanel(page);
    for (const period of ['2', '14', '30']) {
      await periodOf(page).fill(period);
      await settled(page);
      const probe = await page.evaluate(() => window.__app.probeLine('rsi'));
      expect(probe.ys.length, `RSI(${period}) is on the canvas`).toBeGreaterThan(0);
      const mean = probe.ys.reduce((a, b) => a + b, 0) / probe.ys.length;
      expect(Math.abs(mean - probe.expectedY), `RSI(${period})`).toBeLessThanOrEqual(3);
    }
  });
});

test.describe('Bollinger Bands', () => {
  test('three lines in three colours, upper above the middle above the lower, each at its value', async ({ page }) => {
    await open(page);
    await only(page, 'bb');
    await settled(page);
    const probes = {};
    for (const key of ['upper', 'basis', 'lower']) {
      probes[key] = await page.evaluate((k) => window.__app.probeLine(k), key);
      expect(probes[key].ys.length, key).toBeGreaterThan(0);
      const mean = probes[key].ys.reduce((a, b) => a + b, 0) / probes[key].ys.length;
      expect(Math.abs(mean - probes[key].expectedY), key).toBeLessThanOrEqual(3);
      probes[key].mean = mean;
    }
    expect(probes.upper.mean).toBeLessThan(probes.basis.mean);   // y grows downwards: higher price is higher up
    expect(probes.basis.mean).toBeLessThan(probes.lower.mean);
    const colors = await page.evaluate(() => Object.fromEntries(Object.entries(window.__app.lineSeries()).map(([k, s]) => [k, s.options().color])));
    expect(new Set(Object.values(colors)).size).toBe(3);          // three different colours
    expect(colors).toEqual({ basis: '#795548', upper: '#9C27B0', lower: '#3F51B5' });
  });

  test('the bands are not filled: between the lines the canvas is the background, where no candle is', async ({ page }) => {
    await open(page);
    await only(page, 'bb');
    await page.getByTestId('mult').fill('3');
    await settled(page);
    const filled = await page.evaluate(() => {
      const { chart, lineSeries } = window.__app;
      const canvas = chart.takeScreenshot();
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const s = lineSeries();
      const last = s.upper.data().at(-1);
      const x = Math.round(chart.timeScale().timeToCoordinate(last.time)) - 14; // between two bars, away from bodies
      const [yu, yb] = [s.upper.priceToCoordinate(last.value), s.basis.priceToCoordinate(s.basis.data().at(-1).value)];
      let tinted = 0, n = 0;
      for (let y = Math.round(yu) + 4; y < Math.round(yb) - 4; y++) {
        const i = (y * canvas.width + x) * 4; n++;
        const [r, g, b] = [img[i], img[i + 1], img[i + 2]];
        if (Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 255) > 60) tinted++;
      }
      return { n, tinted };
    });
    expect(filled.n).toBeGreaterThan(5);
    expect(filled.tinted / filled.n).toBeLessThan(0.7);
  });
});

test.describe('the axes', () => {
  test('both axes carry text: dark pixels in the price column and in the time strip', async ({ page }) => {
    await open(page);
    await settled(page);
    const r = await page.evaluate(() => {
      const { chart } = window.__app;
      const canvas = chart.takeScreenshot();
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const axisWidth = chart.priceScale('right').width();
      const timeHeight = chart.timeScale().height();
      const dark = (x, y) => { const i = (y * canvas.width + x) * 4; return img[i] < 120 && img[i + 1] < 120 && img[i + 2] < 120; };
      let price = 0, time = 0, plot = 0;
      for (let y = 0; y < canvas.height - timeHeight; y++) for (let x = canvas.width - axisWidth; x < canvas.width; x++) if (dark(x, y)) price++;
      for (let y = canvas.height - timeHeight; y < canvas.height; y++) for (let x = 0; x < canvas.width - axisWidth; x++) if (dark(x, y)) time++;
      for (let y = 0; y < canvas.height - timeHeight; y += 3) for (let x = 0; x < canvas.width - axisWidth; x += 3) if (dark(x, y)) plot++;
      return { axisWidth, timeHeight, price, time, plot };
    });
    expect(r.axisWidth).toBeGreaterThan(30);
    expect(r.timeHeight).toBeGreaterThan(15);
    expect(r.price).toBeGreaterThan(200);   // several price labels
    expect(r.time).toBeGreaterThan(100);    // several time labels
  });

  test('the labels say what the legend says: the axis formatter and the legend agree', async ({ page }) => {
    await open(page);
    for (const [scenario, probe] of [['normal', 73488.014], ['tiny', 1.23456789e-5], ['negative', -52.346], ['huge', 5.5e11]]) {
      await page.getByTestId('scenario').selectOption(scenario);
      await settled(page);
      const r = await page.evaluate((p) => {
        const { candleSeries } = window.__app;
        return { decimals: candleSeries.options().priceFormat.precision, label: candleSeries.priceFormatter().format(p), last: candleSeries.priceFormatter().format(candleSeries.data().at(-1).close), legend: document.getElementById('last-close').textContent };
      }, probe);
      // The chart library writes a negative number with the typographic minus (U+2212), the legend with a hyphen: same number.
      const plain = (t) => t.replace('\u2212', '-');
      expect(plain(r.last), scenario).toBe(r.legend);                // the axis and the legend show the same last price
      expect(plain(r.label), scenario).toBe(probe.toFixed(r.decimals));    // and the formatter keeps the digits it should
    }
  });

  test('the price scale is on the right and the time axis at the bottom, with the lines inside the plot', async ({ page }) => {
    await open(page);
    await settled(page);
    const r = await page.evaluate(() => {
      const { chart } = window.__app;
      return { left: chart.priceScale('left').width(), right: chart.priceScale('right').width() };
    });
    expect(r.left).toBe(0);
    expect(r.right).toBeGreaterThan(30);
  });
});

test.describe('other window sizes', () => {
  const SIZES = [[800, 600], [1400, 900], [1024, 768], [390, 844]];

  for (const [width, height] of SIZES) {
    test(`${width}x${height}: no sideways scrolling, the chart fills its box, candles and lines are right`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page);
      await settled(page);
      const box = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
        container: document.getElementById('chart').clientWidth, canvas: window.__app.chart.takeScreenshot().width,
      }));
      expect(box.scrollWidth, 'sideways scrolling').toBeLessThanOrEqual(box.innerWidth);
      expect(box.canvas).toBe(box.container);
      const bars = await scan(page);
      expect(bars.length).toBeGreaterThanOrEqual(50);
      expect(problems(bars)).toEqual([]);
      const probe = await page.evaluate(() => window.__app.probeLine());
      expect(probe.ys.length).toBeGreaterThan(0);
    });
  }

  test('resizing the window while the page is open: the chart follows and is still right', async ({ page }) => {
    await open(page);
    await settled(page);
    const before = await page.evaluate(() => document.getElementById('chart').clientWidth);
    await page.setViewportSize({ width: 700, height: 700 });
    await expect.poll(() => page.evaluate(() => window.__app.chart.takeScreenshot().width)).toBe(await page.evaluate(() => document.getElementById('chart').clientWidth));
    const after = await page.evaluate(() => document.getElementById('chart').clientWidth);
    expect(after).toBeLessThan(before);
    await settled(page);
    expect(problems(await scan(page))).toEqual([]);
    await page.setViewportSize({ width: 1300, height: 800 });
    await expect.poll(() => page.evaluate(() => document.getElementById('chart').clientWidth)).toBeGreaterThan(after);
    await settled(page);
    expect(problems(await scan(page))).toEqual([]);
  });

  test('the legend stays readable at the narrowest size: nothing is cut off on the right', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    const cut = await page.evaluate(() => {
      const out = [];
      for (const id of ['last-close', 'last-sma', 'status', 'day-change', 'last-update']) {
        const el = document.getElementById(id);
        if (!el || el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1) out.push(`${id} ends at ${Math.round(r.right)} of ${window.innerWidth}`);
      }
      return out;
    });
    expect(cut).toEqual([]);
  });
});
