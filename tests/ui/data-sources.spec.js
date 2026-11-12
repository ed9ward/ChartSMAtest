import { test, expect } from './fixtures.js';
import { pretendExchanges } from './exchanges.js';
import { PROVIDERS } from '../../src/providers.js';

// What a user is offered as a data source: the two exchanges. The synthetic data sets are only for tests and development (?demo).
const DEMO_SETS = ['normal', 'long', 'negative', 'huge', 'overflow', 'nan', 'inconsistent', 'flat', 'stalled', 'tiny', 'duplicates', 'unordered', 'empty'];
const options = (page) => page.getByTestId('scenario').locator('option').allTextContents();

test.describe('the page as a user opens it (no ?demo)', () => {
  test.beforeEach(async ({ page }) => {
    await pretendExchanges(page);
    await page.goto('/');
    await page.waitForFunction(() => window.__app);
  });

  test('only the two exchanges are offered, Binance first and selected', async ({ page }) => {
    expect(await options(page)).toEqual(['Binance live', 'Coinbase live']);
    await expect(page.getByTestId('scenario')).toHaveValue('binance');
  });

  test('it is live on Binance at once, with Binance\'s own instruments and the default timeframe', async ({ page }) => {
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(PROVIDERS.binance.symbols);
    await expect(page.getByTestId('interval')).toHaveValue('1m');
    await expect(page.getByTestId('bar-count')).not.toHaveText('0');
    await expect(page.getByTestId('day-change')).not.toHaveText('—');
  });

  test('no synthetic data set can be chosen', async ({ page }) => {
    for (const name of DEMO_SETS) {
      await expect(page.getByTestId('scenario').locator('option', { hasText: new RegExp(`^${name}$`) })).toHaveCount(0);
    }
    await expect(page.getByTestId('scenario').selectOption('normal', { timeout: 500 })).rejects.toThrow();
  });

  test('the demo stream buttons are not there, the connection buttons are', async ({ page }) => {
    await expect(page.getByTestId('start')).toBeHidden();
    await expect(page.getByTestId('stop')).toBeHidden();
    await expect(page.getByTestId('disconnect')).toBeVisible();
    await expect(page.getByTestId('reconnect')).toBeVisible();
  });

  test('Coinbase is the second choice, with its own instruments', async ({ page }) => {
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
    expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(PROVIDERS.coinbase.symbols);
  });

  test('the indicators work at once on the first screen: SMA is on, the rest can be switched on', async ({ page }) => {
    await expect(page.getByTestId('ind-sma')).toBeChecked();
    await page.getByTestId('ind-ema').setChecked(true);
    await page.getByTestId('ind-bb').setChecked(true);
    await page.getByTestId('ind-rsi').setChecked(true);
    expect(await page.evaluate(() => Object.keys(window.__app.lineSeries()))).toEqual(['sma', 'ema', 'basis', 'upper', 'lower', 'rsi']);
  });

  test('another word in the address does not switch the demo sets on', async ({ page }) => {
    await pretendExchanges(page);
    await page.goto('/?bug=offbyone&demos=1&Demo=1');
    await page.waitForFunction(() => window.__app);
    expect(await options(page)).toEqual(['Binance live', 'Coinbase live']);
  });
});

test.describe('Binance is not reachable from here', () => {
  test('the page says so and Coinbase is one choice away, with no made-up data in between', async ({ page, errors }) => {
    await pretendExchanges(page);
    await page.route('https://api.binance.com/**', (route) => route.fulfill({ status: 451, headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
    await page.goto('/');
    await page.waitForFunction(() => window.__app);
    await expect(page.getByTestId('status')).toHaveText('Failed to load BTCUSDT 1m: HTTP 451');
    await expect(page.getByTestId('bar-count')).toHaveText('0');
    expect(await page.evaluate(() => window.__app.candleData().length)).toBe(0);   // nothing drawn
    await page.getByTestId('scenario').selectOption('coinbase');
    await expect(page.getByTestId('status')).toHaveText('Live BTC-USD 1m');
    await expect(page.getByTestId('bar-count')).not.toHaveText('0');
    expect(errors.every((e) => /status of 451/.test(e))).toBe(true); // only the refusal we caused is logged by the browser
    errors.length = 0;
  });
});

test.describe('the development page (?demo)', () => {
  test('the exchanges stay first, then the synthetic sets, and the first of those is selected', async ({ page }) => {
    await page.goto('/?demo');
    await page.waitForFunction(() => window.__app);
    expect(await options(page)).toEqual(['Binance live', 'Coinbase live', ...DEMO_SETS]);
    await expect(page.getByTestId('scenario')).toHaveValue('normal');
    await expect(page.getByTestId('bar-count')).toHaveText('60');
    await expect(page.getByTestId('status')).toHaveText('OK');
  });

  test('the demo stream buttons are there', async ({ page }) => {
    await page.goto('/?demo');
    await page.waitForFunction(() => window.__app);
    await expect(page.getByTestId('start')).toBeVisible();
    await expect(page.getByTestId('stop')).toBeVisible();
  });

  test('an exchange can still be chosen from it', async ({ page }) => {
    await pretendExchanges(page);
    await page.goto('/?demo');
    await page.waitForFunction(() => window.__app);
    await page.getByTestId('scenario').selectOption('binance');
    await expect(page.getByTestId('status')).toHaveText('Live BTCUSDT 1m');
  });
});
