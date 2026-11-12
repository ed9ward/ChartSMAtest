import { readFileSync } from 'node:fs';
import { test, expect, open } from './fixtures.js';
import { only, periodOf, sourceOf, mainValue, labelOf } from './fixtures.js';
import { PROVIDERS } from '../../src/providers.js';
import { computeIndicator } from '../../src/indicators.js';
import { compareSeries } from '../../checks/reference.js';

// Every instrument the symbol list offers, on both exchanges: it loads, is drawn, is calculated right, follows the stream,
// ignores other instruments' messages, shows its own change per day. The list is read from the providers, so a symbol added
// to it is covered here at once. The exchanges are pretend ones, with prices of the size each instrument really has.
const RAW = JSON.parse(readFileSync(new URL('../fixtures/binance-btcusdt-1m-500.json', import.meta.url)));
const BASE_PRICE = 73_500;                       // what the fixture's prices are around
const PRICES = { BTCUSDT: 73_500, ETHUSDT: 3_500, SOLUSDT: 150, BNBUSDT: 620, 'BTC-USD': 73_500, 'ETH-USD': 3_500, 'SOL-USD': 150 };
const priceOf = (symbol) => PRICES[symbol] ?? 100;
const JSON_HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const T_LAST = RAW.at(-1)[0];

const binanceRows = (symbol, interval, limit) => {
  const k = priceOf(symbol) / BASE_PRICE;
  if (interval === '1d') { // yesterday closed 2% above the price of the last bar
    const day = Math.floor(T_LAST / 86_400_000) * 86_400_000;
    const last = Number(RAW.at(-1)[4]) * k;
    return [[day - 86_400_000, 1, 1, 1, String(last * 1.02), 1, 0, 0, 0, 0, 0, 0], [day, 1, 1, 1, String(last), 1, 0, 0, 0, 0, 0, 0]];
  }
  return RAW.slice(-limit).map((r) => [r[0], ...[1, 2, 3, 4].map((i) => String(Number(r[i]) * k)), r[5], r[6], r[7], r[8], r[9], r[10], r[11]]);
};
const coinbaseRows = (symbol, granularity, limit) => {
  const k = priceOf(symbol) / BASE_PRICE;
  if (granularity === 86_400) {
    const day = Math.floor(T_LAST / 86_400_000) * 86_400;
    const last = Number(RAW.at(-1)[4]) * k;
    return [[day, last, last, last, last, 1], [day - 86_400, last * 1.02, last * 1.02, last * 1.02, last * 1.02, 1]]; // newest first
  }
  return RAW.slice(-limit).map((r) => [r[0] / 1000, +r[3] * k, +r[2] * k, +r[1] * k, +r[4] * k, +r[5]]).reverse();
};

async function pretendExchanges(page) {
  const seen = { binance: [], coinbase: [], sockets: [] };
  await page.route('https://api.binance.com/api/v3/klines*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    seen.binance.push(q.get('symbol'));
    route.fulfill({ headers: JSON_HEADERS, body: JSON.stringify(binanceRows(q.get('symbol'), q.get('interval'), Number(q.get('limit')))) });
  });
  await page.route('https://api.exchange.coinbase.com/products/*/candles*', (route) => {
    const u = new URL(route.request().url());
    const symbol = u.pathname.split('/')[2];
    seen.coinbase.push(symbol);
    route.fulfill({ headers: JSON_HEADERS, body: JSON.stringify(coinbaseRows(symbol, Number(u.searchParams.get('granularity')), 300)) });
  });
  await page.route('https://api.exchange.coinbase.com/products/*/trades*', (route) => route.fulfill({ headers: JSON_HEADERS, body: '[]' }));
  await page.routeWebSocket(/stream\.binance\.com|ws-feed\.exchange\.coinbase\.com/, (ws) => {
    const entry = { ws, url: ws.url(), closed: false };
    ws.onClose(() => { entry.closed = true; });
    ws.onMessage((m) => {
      const hello = JSON.parse(String(m));
      if (hello.type !== 'subscribe') return;
      const product = hello.channels[0].product_ids[0];
      ws.send(JSON.stringify({ type: 'subscriptions', channels: [] }));
      ws.send(JSON.stringify({ type: 'last_match', trade_id: 1000, product_id: product, price: String(priceOf(product)), size: '0.1', time: new Date(T_LAST).toISOString(), side: 'buy' }));
    });
    seen.sockets.push(entry);
  });
  return seen;
}

const kline = (symbol, close) => JSON.stringify({ e: 'kline', s: symbol, k: { t: T_LAST, s: symbol, i: '1m', o: String(close), h: String(close * 1.001), l: String(close * 0.999), c: String(close), v: '2', x: false } });
const match = (symbol, id, price) => JSON.stringify({ type: 'match', trade_id: id, product_id: symbol, price: String(price), size: '0.1', time: new Date(T_LAST + 10_000).toISOString(), side: 'buy' });

async function goTo(page, exchange, symbol) {
  await page.getByTestId('scenario').selectOption(exchange);
  if (symbol !== PROVIDERS[exchange].symbols[0]) await page.getByTestId('symbol').selectOption(symbol);
  await expect(page.getByTestId('status')).toHaveText(`Live ${symbol} 1m`);
}

for (const exchange of Object.keys(PROVIDERS)) {
  test.describe(`${exchange}: every instrument of the list`, () => {
    test('the list on the page is the list of the provider, in order', async ({ page }) => {
      await pretendExchanges(page);
      await open(page);
      await page.getByTestId('scenario').selectOption(exchange);
      expect(await page.getByTestId('symbol').locator('option').allTextContents()).toEqual(PROVIDERS[exchange].symbols);
    });

    for (const symbol of PROVIDERS[exchange].symbols) {
      test.describe(symbol, () => {
        test('loads its own history, draws it, and shows its own price with the right decimals', async ({ page }) => {
          const seen = await pretendExchanges(page);
          await open(page);
          await goTo(page, exchange, symbol);
          expect(seen[exchange].every((s) => s === symbol || s === PROVIDERS[exchange].symbols[0])).toBe(true); // only itself (and the default's first load)
          expect(seen[exchange]).toContain(symbol);
          const candles = await page.evaluate(() => window.__app.candleData());
          const want = priceOf(symbol);
          expect(candles.length).toBeGreaterThan(250);
          expect(candles.every((c) => c.close > want * 0.9 && c.close < want * 1.1)).toBe(true); // nothing of another instrument's price
          await expect(page.getByTestId('last-close')).toHaveText(candles.at(-1).close.toFixed(2));
          expect(await page.evaluate(() => window.__app.candleSeries.options().priceFormat.precision)).toBe(2);
        });

        test('all four indicators are calculated right on its prices', async ({ page }) => {
          await pretendExchanges(page);
          await open(page);
          await goTo(page, exchange, symbol);
          const candles = (await page.evaluate(() => window.__app.candleData())).map((c) => ({ ...c, volume: 1 }));
          for (const kind of ['sma', 'ema', 'bb', 'rsi']) {
            await only(page, kind);
            const params = await page.evaluate(() => { const s = window.__app.state(); return { period: s.period, mult: s.mult, start: s.start }; });
            const want = computeIndicator(kind, candles, params, 'close');
            for (const [key, points] of Object.entries(want)) {
              const got = await page.evaluate((k) => window.__app.lineData(k), key);
              expect(() => compareSeries(got, points, 6), `${symbol} ${kind}/${key}`).not.toThrow();
              expect(got.length, `${symbol} ${kind}/${key}`).toBeGreaterThan(200);
            }
          }
        });

        test('follows its own stream and ignores another instrument\'s messages', async ({ page }) => {
          const seen = await pretendExchanges(page);
          await open(page);
          await goTo(page, exchange, symbol);
          const socket = seen.sockets.filter((s) => !s.closed).at(-1);
          const other = PROVIDERS[exchange].symbols.find((s) => s !== symbol);
          const before = await page.getByTestId('last-close').textContent();
          const price = priceOf(symbol) * 1.01;
          const send = (m) => socket.ws.send(m);
          // a message about another instrument, with a very different price: it must change nothing
          send(exchange === 'binance' ? kline(other, priceOf(other) * 2) : match(other, 1001, priceOf(other) * 2));
          await page.waitForTimeout(150);
          await expect(page.getByTestId('last-close')).toHaveText(before);
          // its own
          send(exchange === 'binance' ? kline(symbol, price) : match(symbol, 1001, price));
          await expect(page.getByTestId('last-close')).toHaveText(price.toFixed(2));
          const lastSma = await page.evaluate(() => window.__app.smaData().at(-1).value);
          await expect(mainValue(page)).toHaveText(lastSma.toFixed(2));
        });

        test('shows the change per day from its own daily candles', async ({ page }) => {
          await pretendExchanges(page);
          await open(page);
          await goTo(page, exchange, symbol);
          // yesterday closed 2% above the last price: the change is -1/1.02 - 1 = -1.96%
          await expect(page.getByTestId('day-change')).toHaveText('-1.96%');
        });
      });
    }

    test('moving through all of them one after another: each shows only its own prices', async ({ page }) => {
      await pretendExchanges(page);
      await open(page);
      await page.getByTestId('scenario').selectOption(exchange);
      for (const symbol of [...PROVIDERS[exchange].symbols, ...PROVIDERS[exchange].symbols.slice().reverse()]) {
        await page.getByTestId('symbol').selectOption(symbol);
        await expect(page.getByTestId('status')).toHaveText(`Live ${symbol} 1m`);
        const want = priceOf(symbol);
        await expect.poll(async () => (await page.evaluate(() => window.__app.candleData().at(-1).close)) / want).toBeGreaterThan(0.9);
        const candles = await page.evaluate(() => window.__app.candleData());
        expect(candles.every((c) => c.close > want * 0.9 && c.close < want * 1.1), symbol).toBe(true);
      }
    });
  });
}
