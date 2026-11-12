import { test as base, expect } from '@playwright/test';

// Every test fails if the page throws or logs a console error.
export const test = base.extend({
  errors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
export { expect };

// The synthetic data sets are only there with ?demo, so most tests open the page that way.
export async function open(page, query = '') {
  const q = new URLSearchParams(query);
  q.set('demo', '1');
  await page.goto(`/?${q}`);
  await page.waitForFunction(() => window.__app);
}

export const smaData = (page) => page.evaluate(() => window.__app.smaData());
export const candleData = (page) => page.evaluate(() => window.__app.candleData());
export const text = (page, id) => page.getByTestId(id).textContent();

// Where the line of `key` (default: the main line) is drawn and where it should be; see probeLine in src/app.js.
export const probeLine = (page, key) => page.evaluate((k) => window.__app.probeLine(k), key);
export const probeSmaLine = (page) => probeLine(page);

// Distance in px between where the line is drawn and where it should be; 999 when there is no thin line at all.
// maxSpread: how tall the found pixels may be (a 2 px line is ~4 rows, a steep one up to ~8).
export function offsetFromExpected(probe, maxSpread = 12) {
  if (!probe || probe.ys.length === 0) return 999;
  if (Math.max(...probe.ys) - Math.min(...probe.ys) > maxSpread) return 999; // not a thin line: the colour match is too loose
  return Math.abs(probe.ys.reduce((a, b) => a + b, 0) / probe.ys.length - probe.expectedY);
}

// For charts with several lines: pixels of this line's colour exist within `tolerance` px of where the line should be.
// (A thin-line test needs the neighbouring lines to be well apart; this one only needs the line to be where it belongs.)
// A failure says what the probe saw, because the CI log cannot always be read.
export async function expectLineNear(page, { key, tolerance = 3 } = {}) {
  let seen;
  await expect.poll(async () => {
    seen = await probeLine(page, key);
    if (!seen || seen.ys.length === 0) return 999;
    return Math.min(...seen.ys.map((y) => Math.abs(y - seen.expectedY)));
  }, { message: () => `line ${key}: expected y ${seen?.expectedY?.toFixed(1)}, pixels of its colour at ${JSON.stringify(seen?.ys?.slice(0, 30))}` }).toBeLessThanOrEqual(tolerance);
}

// Waits until the line is drawn where it should be (the chart repaints a moment after any change).
export async function expectLineAt(page, { key, tolerance = 3 } = {}) {
  await expect.poll(async () => offsetFromExpected(await probeLine(page, key)), { message: `line ${key ?? '(main)'}` })
    .toBeLessThanOrEqual(tolerance);
}

// --- several indicators at once --------------------------------------------------------------------------------------
// Every indicator has its own switch, period and source. Most tests work with one indicator at a time, as the old single
// selector did: `only` switches that one on and the others off, and the helpers below then mean "the indicator of this test".
export const INDICATOR_KINDS = ['sma', 'ema', 'bb', 'rsi'];
const current = new WeakMap(); // page -> the indicator the test is working with
export const kindOf = (page) => current.get(page) ?? 'sma';

export async function only(page, kind) {
  const before = kindOf(page);
  for (const k of INDICATOR_KINDS) {
    const box = page.getByTestId(`ind-${k}`);
    if ((await box.isChecked()) !== (k === kind)) await box.setChecked(k === kind);
  }
  if (before !== kind) { // the old selector had one source for all: carry it over to the indicator that takes over
    const source = await page.getByTestId(`source-${before}`).inputValue();
    await page.getByTestId(`source-${kind}`).selectOption(source);
  }
  current.set(page, kind);
}

export const periodOf = (page, kind = kindOf(page)) => page.getByTestId(`period-${kind}`);
export const sourceOf = (page, kind = kindOf(page)) => page.getByTestId(`source-${kind}`);
export const LEGEND_VALUE = { sma: 'last-sma', ema: 'last-ema', bb: 'last-bb-basis', rsi: 'last-rsi' };
export const mainValue = (page, kind = kindOf(page)) => page.getByTestId(LEGEND_VALUE[kind]);
export const labelOf = (page, kind = kindOf(page)) => page.getByTestId(`legend-label-${kind}`);
