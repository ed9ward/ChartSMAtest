import { test, expect } from './fixtures.js';
import { buildLiveGroups } from '../../checks/live-exchanges.js';
import { INTERVAL_SECONDS } from '../../src/live.js';

// The page's button "Check the real exchanges", driven against pretend exchanges (the real ones are not reachable from a test).
const TOTAL = buildLiveGroups({ fetchFn: async () => {}, WS: class {} }).flatMap((g) => g.checks).length;
const NOW = Date.now();
const PRICE = 73_500;
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

const bRows = (interval, n) => {
  const step = INTERVAL_SECONDS[interval];
  const last = Math.floor(NOW / 1000 / step) * step;
  return Array.from({ length: n }, (_, i) => { const t = (last - (n - 1 - i) * step) * 1000; return [t, String(PRICE), String(PRICE + 20), String(PRICE - 20), String(PRICE + 5), '12.5', t + step * 1000 - 1, '9', 100, '6', '4', '0']; });
};
const cRows = (g) => { const last = Math.floor(NOW / 1000 / g) * g; return Array.from({ length: 300 }, (_, i) => [last - i * g, PRICE - 20, PRICE + 20, PRICE, PRICE + 5, 3.2]); };

async function pretendExchanges(page, o = {}) {
  const seen = { rest: 0, ws: 0 };
  await page.route('https://api.binance.com/**', async (route) => {
    seen.rest++;
    const u = new URL(route.request().url());
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (o.binanceStatus) return route.fulfill({ status: o.binanceStatus, headers: CORS, body: '[]' });
    const body = u.pathname.endsWith('/time') ? { serverTime: NOW } : bRows(u.searchParams.get('interval'), Number(u.searchParams.get('limit')));
    return route.fulfill({ headers: CORS, body: JSON.stringify(body) });
  });
  await page.route('https://api.exchange.coinbase.com/**', (route) => {
    seen.rest++;
    const u = new URL(route.request().url());
    const body = u.pathname === '/time' ? { iso: new Date(NOW).toISOString(), epoch: NOW / 1000 }
      : u.pathname.endsWith('/candles') ? cRows(Number(u.searchParams.get('granularity')))
        : Array.from({ length: Number(u.searchParams.get('limit')) }, (_, i) => ({ trade_id: 90_000 - i, price: String(PRICE), size: '0.01', time: new Date(NOW - i * 500).toISOString(), side: 'buy' }));
    return route.fulfill({ headers: CORS, body: JSON.stringify(body) });
  });
  await page.routeWebSocket(/stream\.binance\.com/, (ws) => {
    seen.ws++;
    if (o.binanceSilent) return;
    const t = Math.floor(NOW / 60_000) * 60_000;
    const k = { t, s: 'BTCUSDT', i: '1m', o: String(PRICE), h: String(PRICE + 20), l: String(PRICE - 20), c: String(PRICE + 5), v: '1.5', x: false };
    ws.send(JSON.stringify({ e: 'kline', E: NOW, s: 'BTCUSDT', k }));
  });
  await page.routeWebSocket(/ws-feed\.exchange\.coinbase\.com/, (ws) => {
    seen.ws++;
    ws.onMessage(() => {
      ws.send(JSON.stringify({ type: 'subscriptions', channels: [] }));
      ws.send(JSON.stringify({ type: 'last_match', trade_id: 90_000, product_id: 'BTC-USD', price: String(PRICE), size: '0.1', time: new Date(NOW).toISOString(), side: 'buy' }));
      ws.send(JSON.stringify({ type: 'heartbeat', sequence: 5, last_trade_id: 90_000, product_id: 'BTC-USD', time: new Date(NOW).toISOString() }));
    });
  });
  return seen;
}

const state = (page) => page.getByTestId('state');

test.describe('the "Check the real exchanges" button', () => {
  test('the button is there, with an honest note that it needs the internet', async ({ page }) => {
    await page.goto('/checks.html');
    await expect(page.getByTestId('run-live')).toBeEnabled();
    await expect(page.getByTestId('run-live')).toContainText('needs internet');
    await expect(page.getByText('Not part of "Run all checks"')).toBeVisible();
  });

  test('against well-behaved exchanges every check passes, in three groups', async ({ page }) => {
    await pretendExchanges(page);
    await page.goto('/checks.html');
    await page.getByTestId('run-live').click();
    await expect(state(page)).toHaveText('finished', { timeout: 30_000 });
    await expect(page.getByTestId('verdict')).toHaveText(new RegExp(`^All ${TOTAL} live checks against the real exchanges passed`));
    await expect(page.getByTestId('failed')).toHaveText('0');
    await expect(page.getByTestId('passed')).toHaveText(String(TOTAL));
    for (const id of ['live-binance', 'live-coinbase', 'live-cross']) await expect(page.getByTestId(`group-${id}`)).toBeVisible();
    await expect(page.getByTestId('group-live-binance')).toContainText('Binance (the real exchange)');
  });

  test('"Run all checks" never touches the exchanges: no request, no connection', async ({ page }) => {
    const seen = await pretendExchanges(page);
    await page.goto('/checks.html');
    await page.getByTestId('include-ui').uncheck();
    await page.getByTestId('run').click();
    await expect(state(page)).toHaveText('finished', { timeout: 60_000 });
    await expect(page.getByTestId('failed')).toHaveText('0');
    expect(seen).toEqual({ rest: 0, ws: 0 });
    await expect(page.getByTestId('group-live-binance')).toHaveCount(0);   // and the live groups are not in its table
  });

  test('a refusal by the exchange is shown with the reason and a hint, and the other exchange still passes', async ({ page, errors }) => {
    await pretendExchanges(page, { binanceStatus: 451 });
    await page.goto('/checks.html');
    await page.getByTestId('run-live').click();
    await expect(state(page)).toHaveText('finished', { timeout: 30_000 });
    await expect(page.getByTestId('verdict')).toContainText('live checks failed');
    await expect(page.getByTestId('details-live-binance')).toContainText('HTTP 451: the exchange does not serve this network or region');
    await expect(page.getByTestId('group-live-coinbase').locator('.failed')).toHaveText('0');
    await expect(page.getByTestId('group-live-binance').locator('.failed')).not.toHaveText('0');
    expect(errors.every((e) => /status of 451/.test(e))).toBe(true); // only the refusals we caused are logged by the browser
    errors.length = 0;
  });

  test('a silent stream fails with its own message after the time asked for (liveTimeout)', async ({ page }) => {
    await pretendExchanges(page, { binanceSilent: true });
    await page.goto('/checks.html?liveTimeout=400');
    await page.getByTestId('run-live').click();
    await expect(state(page)).toHaveText('finished', { timeout: 30_000 });
    await expect(page.getByTestId('details-live-binance')).toContainText('nothing suitable arrived within 0.4 s');
    await expect(page.getByTestId('group-live-coinbase').locator('.failed')).toHaveText('0');
  });

  test('both buttons are locked while it runs and free afterwards; it can be run again', async ({ page }) => {
    await pretendExchanges(page, { delayMs: 150 });
    await page.goto('/checks.html');
    await page.getByTestId('run-live').click();
    await expect(page.getByTestId('run-live')).toBeDisabled();
    await expect(page.getByTestId('run')).toBeDisabled();
    await expect(state(page)).toHaveText('finished', { timeout: 60_000 });
    await expect(page.getByTestId('run-live')).toBeEnabled();
    await expect(page.getByTestId('run')).toBeEnabled();
    await page.getByTestId('run-live').click();
    await expect(state(page)).toHaveText('finished', { timeout: 60_000 });
    await expect(page.getByTestId('passed')).toHaveText(String(TOTAL));   // the counters start again, they do not add up
  });

  test('the network being down is reported, not thrown: the page stays usable', async ({ page, errors }) => {
    await page.route('https://api.binance.com/**', (r) => r.abort());
    await page.route('https://api.exchange.coinbase.com/**', (r) => r.abort());
    await page.routeWebSocket(/stream\.binance\.com|ws-feed\.exchange\.coinbase\.com/, (ws) => ws.close());
    await page.goto('/checks.html?liveTimeout=400');
    await page.getByTestId('run-live').click();
    await expect(state(page)).toHaveText('finished', { timeout: 30_000 });
    await expect(page.getByTestId('failed')).toHaveText(String(TOTAL));
    await expect(page.getByTestId('details-live-binance')).toContainText('could not reach api.binance.com');
    await expect(page.getByTestId('run')).toBeEnabled();
    errors.length = 0; // the browser logs every refused request itself
  });
});
