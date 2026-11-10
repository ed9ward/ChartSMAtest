import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { buildGroups } from '../../checks/definitions.js';

// How many checks the suite has, counted straight from the definitions (not from the page).
const rows = JSON.parse(readFileSync(new URL('../fixtures/btcusdt-1m.json', import.meta.url)));
const groups = buildGroups({ realRows: async () => rows, realCandles: async () => [] });
const ALL = groups.flatMap((g) => g.checks).length;
const NO_UI = groups.flatMap((g) => g.checks).filter((c) => !c.ui).length;
const GROUP_IDS = groups.map((g) => g.id);

const number = async (locator) => Number((await locator.textContent()).trim());
const state = (page) => page.getByTestId('state');

async function runAndWait(page, timeout = 60_000) {
  await page.getByTestId('run').click();
  await expect(state(page)).toHaveText('finished', { timeout });
}

test.describe('self-checks page', () => {
  test.setTimeout(90_000);

  test('starts idle with a run button and a link back to the chart', async ({ page }) => {
    await page.goto('/checks.html');
    await expect(state(page)).toHaveText('idle');
    await expect(page.getByTestId('run')).toBeEnabled();
    await expect(page.getByTestId('include-ui')).toBeChecked();
    await expect(page.getByTestId('counter')).toHaveText('0 / 0');
    await expect(page.getByRole('link', { name: /back to the chart/ })).toHaveAttribute('href', 'index.html');
  });

  test('the chart page links to the checks', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-checks').click();
    await expect(page).toHaveURL(/checks\.html$/);
  });

  test('a full run passes everything and reports totals, groups and times', async ({ page }) => {
    await page.goto('/checks.html');
    await runAndWait(page);

    await expect(page.getByTestId('verdict')).toHaveText(new RegExp(`^All ${ALL} checks passed in `));
    await expect(page.getByTestId('counter')).toHaveText(`${ALL} / ${ALL}`);
    expect(await number(page.getByTestId('passed'))).toBe(ALL);
    expect(await number(page.getByTestId('failed'))).toBe(0);
    await expect(page.getByTestId('elapsed')).toHaveText(/\d+(\.\d+)? (ms|s)$/);
    await expect(page.getByTestId('progress')).toHaveJSProperty('value', ALL);
    await expect(page.getByTestId('check-fail')).toHaveCount(0);
    await expect(page.getByTestId('check-ok')).toHaveCount(ALL);

    let sum = 0;
    for (const id of GROUP_IDS) {
      const row = page.getByTestId(`group-${id}`);
      await expect(row).toBeVisible();
      const total = await number(row.locator('.total'));
      expect(await number(row.locator('.passed'))).toBe(total);
      expect(await number(row.locator('.failed'))).toBe(0);
      await expect(row.locator('.time')).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
      await expect(row).toHaveClass(/done-ok/);
      sum += total;
    }
    expect(sum).toBe(ALL);
  });

  test('the four indicators are listed with their own checks and times', async ({ page }) => {
    await page.goto('/checks.html');
    await runAndWait(page);
    for (const [id, title] of [['sma', 'SMA'], ['ema', 'EMA'], ['bb', 'Bollinger Bands'], ['rsi', 'RSI']]) {
      const row = page.getByTestId(`group-${id}`);
      await expect(row).toContainText(title);
      expect(await number(row.locator('.total'))).toBeGreaterThan(50);
    }
  });

  test('progress is visible while running: the button is locked, counters grow, then everything unlocks', async ({ page }) => {
    await page.goto('/checks.html');
    await page.getByTestId('watch').check();
    await page.getByTestId('run').click();
    await expect(state(page)).toHaveText('running');
    await expect(page.getByTestId('run')).toBeDisabled();
    await expect(page.getByTestId('include-ui')).toBeDisabled();

    const seen = new Set();
    let last = 0;
    await expect.poll(async () => {
      // one read, so the counter and the bar are taken at the same moment
      const now = await page.evaluate(() => ({
        done: Number(document.getElementById('counter').textContent.split('/')[0]),
        bar: document.getElementById('bar').value,
        state: document.getElementById('state').textContent,
      }));
      expect(now.done).toBeGreaterThanOrEqual(last); // never goes backwards
      expect(now.bar).toBe(now.done);
      last = now.done;
      seen.add(now.done);
      return now.state;
    }, { timeout: 60_000, intervals: [100] }).toBe('finished');

    expect(seen.size).toBeGreaterThan(5); // really progressive, not one jump
    expect([...seen].some((n) => n > 0 && n < ALL)).toBe(true);
    await expect(page.getByTestId('run')).toBeEnabled();
    await expect(page.getByTestId('verdict')).toContainText(`All ${ALL} checks passed`);
    await expect(page.getByTestId('verdict')).toContainText('the checks themselves took');
  });

  test('the current check is named while running', async ({ page }) => {
    await page.goto('/checks.html');
    await page.getByTestId('watch').check();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('current')).toContainText('›');
    await expect(state(page)).toHaveText('finished', { timeout: 60_000 });
    await expect(page.getByTestId('current')).toHaveText('');
  });

  test('without UI checks only the pure checks run and the chart is not loaded', async ({ page }) => {
    await page.goto('/checks.html');
    await page.getByTestId('include-ui').uncheck();
    await runAndWait(page);
    await expect(page.getByTestId('verdict')).toHaveText(new RegExp(`^All ${NO_UI} checks passed`));
    await expect(page.getByTestId('counter')).toHaveText(`${NO_UI} / ${NO_UI}`);
    expect(NO_UI).toBeLessThan(ALL);
    expect(await page.locator('#app').getAttribute('src')).toBeNull();
  });

  test('running twice starts from scratch with the same result', async ({ page }) => {
    await page.goto('/checks.html');
    await runAndWait(page);
    const first = await page.getByTestId('counter').textContent();
    await page.getByTestId('run').click();
    await expect(page.getByTestId('verdict')).toHaveText('');
    await expect(state(page)).toHaveText('finished', { timeout: 60_000 });
    expect(await page.getByTestId('counter').textContent()).toBe(first);
    await expect(page.getByTestId('check-ok')).toHaveCount(ALL);
    await expect(page.locator('[data-testid^="group-"]')).toHaveCount(GROUP_IDS.length);
  });

  test('the chart is left in its normal state after the run', async ({ page }) => {
    await page.goto('/checks.html');
    await runAndWait(page);
    const frame = page.frameLocator('#app');
    await expect(frame.getByTestId('scenario')).toHaveValue('normal');
    await expect(frame.getByTestId('indicator')).toHaveValue('sma');
    await expect(frame.getByTestId('bar-count')).toHaveText('60');
  });

  test('a broken chart makes the checks fail: only the UI parts of the four indicators', async ({ page }) => {
    await page.goto('/checks.html?bug=offbyone');
    await runAndWait(page);
    await expect(page.getByTestId('verdict')).toHaveText(/checks failed/);
    expect(await number(page.getByTestId('failed'))).toBeGreaterThan(40);
    for (const id of ['sma', 'ema', 'bb', 'rsi']) {
      const row = page.getByTestId(`group-${id}`);
      expect(await number(row.locator('.failed'))).toBeGreaterThan(5);
      await expect(row).toHaveClass(/done-bad/);
      await expect(page.getByTestId(`details-${id}`)).toHaveAttribute('open', '');
      // the legend check itself must notice the wrong value, not only the series comparisons
      await expect(page.getByTestId(`details-${id}`).locator('li.fail', { hasText: 'legend shows the last value' })).toHaveCount(1);
    }
    for (const id of ['data', 'binance']) {
      expect(await number(page.getByTestId(`group-${id}`).locator('.failed'))).toBe(0);
    }
    const failure = page.getByTestId('check-fail').first();
    await expect(failure.locator('.err')).not.toBeEmpty();
    expect(await number(page.getByTestId('passed')) + await number(page.getByTestId('failed'))).toBe(ALL);
  });

  test('a failed run can be followed by a clean run of the same page object', async ({ page }) => {
    await page.goto('/checks.html?bug=offbyone');
    await runAndWait(page);
    await expect(page.getByTestId('verdict')).toHaveText(/failed/);
    await page.goto('/checks.html');
    await runAndWait(page);
    await expect(page.getByTestId('verdict')).toHaveText(/^All/);
  });
});
