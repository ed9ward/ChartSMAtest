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

export async function open(page, query = '') {
  await page.goto('/' + query);
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

// Waits until the line is drawn where it should be (the chart repaints a moment after any change).
export async function expectLineAt(page, { key, tolerance = 3 } = {}) {
  await expect.poll(async () => offsetFromExpected(await probeLine(page, key)), { message: `line ${key ?? '(main)'}` })
    .toBeLessThanOrEqual(tolerance);
}
