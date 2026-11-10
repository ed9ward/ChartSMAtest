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

// Reads the real chart canvas: finds orange (SMA line) pixels in the column of the last SMA point.
export function probeSmaLine(page) {
  return page.evaluate(() => {
    const { chart, smaSeries } = window.__app;
    const last = smaSeries.data().at(-1);
    const x = Math.round(chart.timeScale().timeToCoordinate(last.time)) - 1; // the line ends at the bar centre
    const expectedY = smaSeries.priceToCoordinate(last.value);
    const canvas = chart.takeScreenshot();
    const px = canvas.getContext('2d').getImageData(x, 0, 1, canvas.height).data;
    const ys = [];
    for (let y = 0; y < canvas.height; y++) {
      const r = px[y * 4], g = px[y * 4 + 1], b = px[y * 4 + 2];
      if (r > 220 && g > 120 && g < 215 && b < 140 && r - b > 120) ys.push(y); // orange, also when anti-aliased
    }
    return { expectedY, ys, height: canvas.height };
  });
}
